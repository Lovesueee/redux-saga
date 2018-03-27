import { CHANNEL_END_TYPE, MATCH, MULTICAST, SAGA_ACTION } from './symbols'
import { is, check, remove, once, internalErr } from './utils'
import * as buffers from './buffers'
import { asap } from './scheduler'
import * as matchers from './matcher'

export const END = { type: CHANNEL_END_TYPE }
export const isEnd = a => a && a.type === CHANNEL_END_TYPE

const INVALID_BUFFER = 'invalid buffer passed to channel factory function'
const UNDEFINED_INPUT_ERROR = `Saga or channel was provided with an undefined action
Hints:
  - check that your Action Creator returns a non-undefined value
  - if the Saga was started using runSaga, check that your subscribe source provides the action to its listeners`

export function channel(buffer = buffers.expanding()) {
  let closed = false
  let takers = []

  if (process.env.NODE_ENV === 'development') {
    check(buffer, is.buffer, INVALID_BUFFER)
  }

  function checkForbiddenStates() {
    if (closed && takers.length) {
      throw internalErr('Cannot have a closed channel with pending takers')
    }
    if (takers.length && !buffer.isEmpty()) {
      throw internalErr('Cannot have pending takers with non empty buffer')
    }
  }

  function put(input) {
    checkForbiddenStates()

    if (process.env.NODE_ENV === 'development') {
      check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
    }

    if (closed) {
      return
    }
    if (!takers.length) {
      return buffer.put(input)
    }
    const cb = takers[0]
    takers.splice(0, 1)
    cb(input)
  }

  function take(cb) {
    checkForbiddenStates()

    if (process.env.NODE_ENV === 'development') {
      check(cb, is.func, "channel.take's callback must be a function")
    }

    if (closed && buffer.isEmpty()) {
      cb(END)
    } else if (!buffer.isEmpty()) {
      cb(buffer.take())
    } else {
      takers.push(cb)
      cb.cancel = () => remove(takers, cb)
    }
  }

  function flush(cb) {
    checkForbiddenStates() // TODO: check if some new state should be forbidden now

    if (process.env.NODE_ENV === 'development') {
      check(cb, is.func, "channel.flush' callback must be a function")
    }

    if (closed && buffer.isEmpty()) {
      cb(END)
      return
    }
    cb(buffer.flush())
  }

  function close() {
    checkForbiddenStates()
    if (!closed) {
      closed = true
      if (takers.length) {
        const arr = takers
        takers = []
        for (let i = 0, len = arr.length; i < len; i++) {
          const taker = arr[i]
          taker(END)
        }
      }
    }
  }

  return {
    take,
    put,
    flush,
    close,
  }
}

export function eventChannel(subscribe, buffer = buffers.none()) {
  let closed = false
  let unsubscribe

  const chan = channel(buffer)
  const close = () => {
    if (is.func(unsubscribe)) {
      unsubscribe()
    }
    chan.close()
  }

  unsubscribe = subscribe(input => {
    if (isEnd(input)) {
      close()
      closed = true
      return
    }
    chan.put(input)
  })

  if (!is.func(unsubscribe)) {
    throw new Error('in eventChannel: subscribe should return a function to unsubscribe')
  }

  unsubscribe = once(unsubscribe)

  if (closed) {
    unsubscribe()
  }

  return {
    take: chan.take,
    flush: chan.flush,
    close,
  }
}

export function multicastChannel() {
  let closed = false
  let currentTakers = []
  let nextTakers = currentTakers

  const ensureCanMutateNextTakers = () => {
    if (nextTakers !== currentTakers) {
      return
    }
    nextTakers = currentTakers.slice()
  }

  // TODO: check if its possible to extract closing function and reuse it in both unicasts and multicasts
  // 关闭 channel (通道)
  const close = () => {
    // 标记
    closed = true
    // 获取最新的 takers (监听者)
    const takers = (currentTakers = nextTakers)

    for (let i = 0; i < takers.length; i++) {
      const taker = takers[i]
      taker(END) // 发送 END 消息 (action)
    }

    // 清空 takers
    nextTakers = []
  }

  return {
    [MULTICAST]: true,
    put(input) {
      // TODO: should I check forbidden state here? 1 of them is even impossible
      // as we do not possibility of buffer here
      if (process.env.NODE_ENV === 'development') {
        check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
      }

      // 如果 channel 已关闭，put 是没有任何效果的
      if (closed) {
        return
      }
      // 如果这个消息是 end 消息 (内部消息)
      // 那么关闭该 channel
      if (isEnd(input)) {
        close()
        return
      }
      // 获取最新的 takers
      const takers = (currentTakers = nextTakers)
      for (let i = 0; i < takers.length; i++) {
        const taker = takers[i]
        // 匹配的话，执行回调（执行一次，就 cancel 删除掉）
        // 有点像 `任务` 的感觉，做完 就删除。
        if (taker[MATCH](input)) {
          taker.cancel() //
          taker(input)
        }
      }
    },
    take(cb, matcher = matchers.wildcard) {
      // 如果 channel 已关闭，那么注册的回调执行 with END
      if (closed) {
        cb(END)
        return
      }
      // 默认 matcher: wildcard
      // 永远返回 true (任意匹配, *)
      // 这里有个 matcher，是为了匹配指定的 action，执行对应的回调（可多个）
      cb[MATCH] = matcher
      // 注册和取消 不应该在 currentListeners 引用上直接进行
      // 防止影响正在执行的回调函数
      // 场景：回调函数里，有执行take 或 cancel 方法
      ensureCanMutateNextTakers()
      nextTakers.push(cb)
      // 取消监听的方式，是绑定在回调函数上的
      // 这种好处在于，用户不需要再传递 cb 参数！！还是挺不错的~
      // once: 只调用一次
      // take effect 向 next 提供 cancel 方法
      cb.cancel = once(() => {
        ensureCanMutateNextTakers()
        // 内部数组 splice 删除
        remove(nextTakers, cb)
      })
    },
    close, // close 函数单独现在上面，没看太明白，有啥意图？！
  }
}

export function stdChannel() {
  const chan = multicastChannel()
  const { put } = chan
  // hight order function
  // 重写 input 方法
  chan.put = input => {
    // 内部的 saga action
    // 非用户自定义的 action
    // yield put(action);
    if (input[SAGA_ACTION]) {
      put(input)
      return
    }
    // as soon as possible?
    // dispatch(action);
    // 尽可能快的额执行 put 操作
    asap(() => put(input))
  }
  return chan
}
