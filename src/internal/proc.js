import {
  CANCEL,
  CHANNEL_END as CHANNEL_END_SYMBOL,
  TASK,
  TASK_CANCEL as TASK_CANCEL_SYMBOL,
  SELF_CANCELLATION,
} from './symbols'
import {
  noop,
  is,
  log as _log,
  check,
  deferred,
  uid as nextEffectId,
  array,
  remove,
  object,
  makeIterator,
  createSetContextWarning,
} from './utils'

import { getLocation, addSagaStack, sagaStackToString } from './error-utils'

import { asap, suspend, flush } from './scheduler'
import { asEffect } from './io'
import { channel, isEnd } from './channel'
import matcher from './matcher'

export function getMetaInfo(fn) {
  return {
    name: fn.name || 'anonymous',
    location: getLocation(fn),
  }
}

function getIteratorMetaInfo(iterator, fn) {
  if (iterator.isSagaIterator) {
    return { name: iterator.meta.name }
  }
  return getMetaInfo(fn)
}

// TODO: check if this hacky toString stuff is needed
// also check again whats the difference between CHANNEL_END and CHANNEL_END_TYPE
// maybe this could become MAYBE_END
// I guess this gets exported so takeMaybe result can be checked
export const CHANNEL_END = {
  toString() {
    return CHANNEL_END_SYMBOL
  },
}
export const TASK_CANCEL = {
  toString() {
    return TASK_CANCEL_SYMBOL
  },
}

/**
  Used to track a parent task and its forks
  In the new fork model, forked tasks are attached by default to their parent
  We model this using the concept of Parent task && main Task
  main task is the main flow of the current Generator, the parent tasks is the
  aggregation of the main tasks + all its forked tasks.
  Thus the whole model represents an execution tree with multiple branches (vs the
  linear execution tree in sequential (non parallel) programming)

  A parent tasks has the following semantics
  - It completes if all its forks either complete or all cancelled
  - If it's cancelled, all forks are cancelled as well
  - It aborts if any uncaught error bubbles up from forks
  - If it completes, the return value is the one returned by the main task
**/
// fork 一份 Queue 队列
// task queue 的情况跟 每一个 task 都有关系
function forkQueue(mainTask, onAbort, cb) {
  let tasks = [],
    result,
    completed = false
  // 首先向队列中添加 Main Task!!
  addTask(mainTask)

  // 队列 对外的 API
  const getTasks = () => tasks
  const getTaskNames = () => tasks.map(t => t.meta.name)

  // 取消 queue，即 执行所有的 task.cancel
  function abort(err) {
    onAbort()
    cancelAll()
    cb(err, true) // end with error
  }

  // 向 queue 中添加 task ( task 是一个 对象 descriptor)
  function addTask(task) {
    tasks.push(task)
    // 追加方法，task.continue
    // or 重写 task 的 cont 方法
    task.cont = (res, isErr) => {
      // 如果 queue cancel 后，task 将不再继续执行
      // 这个逻辑很重要，在 task.cancel() 的时候会执行到这里
      if (completed) {
        return
      }
      // 将该task从队列中删除
      remove(tasks, task)
      // 执行完后，删除 cont 执行接口(即：只支持执行一次)
      task.cont = noop
      if (isErr) {
        abort(res) // 只要有一个 子 saga 异常抛错了（即：task error)，那么 父 task 终止，并cancel 掉其他子 saga 对应的 task
      } else {
        // mainTask 的结果作为 所有 task 的结果？？
        if (task === mainTask) {
          result = res
        }
        // task 为空，即：都执行完毕，执行 cb!
        // 子 saga 执行完毕
        if (!tasks.length) {
          completed = true
          cb(result)
        }
      }
    }
    // task.cont.cancel = task.cancel
  }

  function cancelAll() {
    if (completed) {
      return
    }
    completed = true
    // 依次 cancel 所有 task
    // 将task.cont置为空函数 noop，即：不可以继续执行下去了
    tasks.forEach(t => {
      t.cont = noop
      t.cancel()
    })
    // 清空队列
    tasks = []
  }

  return {
    addTask,
    cancelAll,
    abort,
    getTasks,
    getTaskNames,
  }
}

function createTaskIterator({ context, fn, args }) {
  // 自身就是 iterator 迭代器 直接返回
  // 即：没法使用 context 和 args 的场景
  if (is.iterator(fn)) {
    return fn
  }

  // catch synchronous failures; see #152 and #441
  // 一般用于 捕获 normal function 执行时报错，甚至是主动 throw new Error(...);
  let result, error
  try {
    result = fn.apply(context, args)
  } catch (err) {
    error = err
  }

  // i.e. a generator function returns an iterator
  // 上述 fn 是 generator function 的情况
  if (is.iterator(result)) {
    return result
  }

  // do not bubble up synchronous failures for detached forks
  // instead create a failed task. See #152 and #441
  // 为 normal function 创建 iterator
  return error
    ? makeIterator(() => {
        throw error
      })
    : makeIterator(
        (function() {
          let pc
          // 将 fn 的返回值看成是：`yielded effect`
          // 这里的 result 可以是 promise 或者 iterator
          // 最后的返回值则是 promise.resolve(arg)的值
          const eff = { done: false, value: result }
          const ret = value => ({ done: true, value })
          return arg => {
            if (!pc) {
              pc = true
              return eff
            } else {
              return ret(arg)
            }
          }
        })(),
      )
}

// 核心函数，处理 saga，返回 task 对象
export default function proc(
  iterator,
  stdChannel,
  dispatch = noop, // 作为独立的api，保证兼容性，没毛病
  getState = noop,
  parentContext = {}, // 因为后续会涉及到嵌套，所以这里会传递 `父 context`
  options = {},
  parentEffectId = 0,
  meta,
  cont, // continue?! 因该是嵌套的时候用到的！
) {
  const { sagaMonitor, logger, onError, middleware } = options
  const log = logger || _log // 默认的 log

  // 打出错误日志
  // level: `error`
  const logError = err => {
    log('error', err)
    if (err.sagaStack) {
      log('error', err.sagaStack)
    }
  }

  // 创建 tasks context，继承 parent context
  // 可继承的上下文！！每一个 task 都用一个 context，并继承 父 saga 的 context，以及最顶层的context
  const taskContext = Object.create(parentContext)

  let crashedEffect = null
  const cancelledDueToErrorTasks = []
  /**
    Tracks the current effect cancellation
    Each time the generator progresses. calling runEffect will set a new value
    on it. It allows propagating cancellation to child effects
  **/
  // next.cancel 会随着 runEffect 的执行而动态改变
  // next 函数 是用来 遍历 iterator 的
  next.cancel = noop

  /**
    Creates a new task descriptor for this generator, We'll also create a main task
    to track the main flow (besides other forked tasks)
  **/
  // 每一个 saga（iterator） 都是一个 task，运行状态通过 _isRunning 标记
  // task.toPromise().then(); 支持 promise 调用
  // 每一个 saga 运行后 都可以理解为一个 可能持续运行着的 task!
  const task = newTask(parentEffectId, meta, iterator, cont)
  // 主任务是用来追踪主流程？！！yep
  const mainTask = { meta, cancel: cancelMain, isRunning: true }

  // 创建 task 队列
  // 并加入 main task!
  const taskQueue = forkQueue(
    mainTask,
    function onAbort() {
      cancelledDueToErrorTasks.push(...taskQueue.getTaskNames())
    },
    end, // 表示 该 task 执行完毕，即所有的子 saga (task) 也执行完毕
  )

  /**
    cancellation of the main task. We'll simply resume the Generator with a Cancel
  **/
  function cancelMain() {
    // cancel
    if (mainTask.isRunning && !mainTask.isCancelled) {
      mainTask.isCancelled = true
      next(TASK_CANCEL) // 主流程向下 传递 task cancel 指令，那么当前的 effect 将执行 对应的 cancel 方法
    }
  }

  /**
    This may be called by a parent generator to trigger/propagate cancellation
    cancel all pending tasks (including the main task), then end the current task.

    Cancellation propagates down to the whole execution tree holded by this Parent task
    It's also propagated to all joiners of this task and their execution tree/joiners

    Cancellation is noop for terminated/Cancelled tasks tasks
  **/
  function cancel() {
    /**
      We need to check both Running and Cancelled status
      Tasks can be Cancelled but still Running
    **/
    //
    if (iterator._isRunning && !iterator._isCancelled) {
      iterator._isCancelled = true
      taskQueue.cancelAll() // cancel all tasks，特别是 mainTask
      /**
        Ending with a Never result will propagate the Cancellation to all joiners
      **/
      // 主动 cancel task (saga | iterator)
      // end task with cancel signal
      end(TASK_CANCEL)
    }
  }
  /**
    attaches cancellation logic to this task's continuation
    this will permit cancellation to propagate down the call chain
  **/
  cont && (cont.cancel = cancel)

  // tracks the running status
  // 标记该 saga generator 处于运行状态
  iterator._isRunning = true

  // kicks up the generator
  // 首次执行
  next()

  // then return the task descriptor to the caller
  // 返回 task descriptor 对象
  return task

  /**
    This is the generator driver
    It's a recursive async/continuation function which calls itself
    until the generator terminates or throws
  **/
  // next 函数驱动 saga generator 串行执行下去
  // 有点像 co 里面的实现
  // 首次执行参数为空
  function next(arg, isErr) {
    // Preventive measure. If we end up here, then there is really something wrong
    // 该 saga (generator) 已经执行完毕（异常抛错，也是一种结束）
    if (!mainTask.isRunning) {
      throw new Error('Trying to resume an already finished generator')
    }

    try {
      // 这里的 try catch 是用来捕获用户的代码异常
      let result
      if (isErr) {
        // 预发报错，或者 请求错误(promise.reject)，主动向业务层抛出异常，可以 try catch 捕获
        result = iterator.throw(arg)
      } else if (arg === TASK_CANCEL) {
        /**
          getting TASK_CANCEL automatically cancels the main task
          We can get this value here

          - By cancelling the parent task manually
          - By joining a Cancelled task
        **/
        // cancel main task
        // next(TASK_CANCEL)
        mainTask.isCancelled = true
        /**
          Cancels the current effect; this will propagate the cancellation down to any called tasks
        **/
        //  cancel 当前的 effect，因为 next.cancel 方法是 动态变化的，由每一个 effect runner 提供！
        next.cancel()
        /**
          If this Generator has a `return` method then invokes it
          This will jump to the finally block
        **/
        // 该 task 取消后，将返回结果 为 'TASK_CANCEL'
        // 执行 generator.return 方法
        result = is.func(iterator.return) ? iterator.return(TASK_CANCEL) : { done: true, value: TASK_CANCEL }
      } else if (arg === CHANNEL_END) {
        // We get CHANNEL_END by taking from a channel that ended using `take` (and not `takem` used to trap End of channels)
        result = is.func(iterator.return) ? iterator.return() : { done: true }
      } else {
        // 正常情况下，执行 generator 下一步
        result = iterator.next(arg)
      }

      // generator 没结束，处理 effect
      if (!result.done) {
        // 这里处理各种各样的 effect
        // 传递 next 下去，是为了让 当前 generator 继续往下走~~
        digestEffect(result.value, parentEffectId, '', next)
      } else {
        /**
          This Generator has ended, terminate the main task and notify the fork queue
        **/
        mainTask.isMainRunning = false
        // 返回上一级 (用于 saga 嵌套)
        // .cont方法是 taskQueue.addTask 内部追加的方法
        // 这里主要是讲结果存放到 taskQueue 中
        // 返回 promise.resolve(result.value)
        mainTask.cont && mainTask.cont(result.value)
      }
    } catch (error) {
      if (mainTask.isCancelled) {
        logError(error)
      }
      mainTask.isMainRunning = false
      // end with error
      mainTask.cont(error, true)
    }
  }

  function end(result, isErr) {
    iterator._isRunning = false
    // stdChannel.close()

    if (!isErr) {
      // 成功执行完毕，获取结果
      iterator._result = result
      // resolve promise
      iterator._deferredEnd && iterator._deferredEnd.resolve(result)
    } else {
      addSagaStack(result, {
        meta,
        effect: crashedEffect,
        cancelledTasks: cancelledDueToErrorTasks,
      })

      if (!task.cont) {
        if (result.sagaStack) {
          result.sagaStack = sagaStackToString(result.sagaStack)
        }

        if (result instanceof Error && onError) {
          onError(result)
        } else {
          // TODO: could we skip this when _deferredEnd is attached?
          logError(result)
        }
      }
      iterator._error = result
      iterator._isAborted = true
      iterator._deferredEnd && iterator._deferredEnd.reject(result)
    }
    // 子 task 将结果传递给 parent task，这样会一层一层往上传递！
    task.cont && task.cont(result, isErr)
    task.joiners.forEach(j => j.cb(result, isErr))
    task.joiners = null
  }

  function runEffect(effect, effectId, currCb) {
    /**
      each effect runner must attach its own logic of cancellation to the provided callback
      it allows this generator to propagate cancellation downward.

      ATTENTION! effect runners must setup the cancel logic by setting cb.cancel = [cancelMethod]
      And the setup must occur before calling the callback

      This is a sort of inversion of control: called async functions are responsible
      of completing the flow by calling the provided continuation; while caller functions
      are responsible for aborting the current flow by calling the attached cancel function

      Library users can attach their own cancellation logic to promises by defining a
      promise[CANCEL] method in their returned promises
      ATTENTION! calling cancel must have no effect on an already completed or cancelled effect
    **/
    let data
    // prettier-ignore
    // 根据 effect 类型 选择不同的 effect runner
    return (
      // Non declarative effect
        is.promise(effect)                      ? resolvePromise(effect, currCb)
      : is.iterator(effect)                     ? resolveIterator(effect, effectId, meta, currCb)

      // declarative effects
      // 通过获取每一种 effect type 对应的 data
      // 如果有数据，则执行对应的 effect
      : (data = asEffect.take(effect))          ? runTakeEffect(data, currCb)
      : (data = asEffect.put(effect))           ? runPutEffect(data, currCb)
      : (data = asEffect.all(effect))           ? runAllEffect(data, effectId, currCb)
      : (data = asEffect.race(effect))          ? runRaceEffect(data, effectId, currCb)
      : (data = asEffect.call(effect))          ? runCallEffect(data, effectId, currCb)
      : (data = asEffect.cps(effect))           ? runCPSEffect(data, currCb)
      : (data = asEffect.fork(effect))          ? runForkEffect(data, effectId, currCb)
      : (data = asEffect.join(effect))          ? runJoinEffect(data, currCb)
      : (data = asEffect.cancel(effect))        ? runCancelEffect(data, currCb)
      : (data = asEffect.select(effect))        ? runSelectEffect(data, currCb)
      : (data = asEffect.actionChannel(effect)) ? runChannelEffect(data, currCb)
      : (data = asEffect.flush(effect))         ? runFlushEffect(data, currCb)
      : (data = asEffect.cancelled(effect))     ? runCancelledEffect(data, currCb)
      : (data = asEffect.getContext(effect))    ? runGetContextEffect(data, currCb)
      : (data = asEffect.setContext(effect))    ? runSetContextEffect(data, currCb)
      : /* anything else returned as is */        currCb(effect) // 并非异步，比如：字面值
    )
  }

  function digestEffect(effect, parentEffectId, label = '', cb) {
    // 子 effect?
    // 貌似 effectId 都是给 sagaMonitor 用的，可以忽略
    const effectId = nextEffectId()
    sagaMonitor && sagaMonitor.effectTriggered({ effectId, parentEffectId, label, effect })

    /**
      completion callback and cancel callback are mutually exclusive
      We can't cancel an already completed effect
      And We can't complete an already cancelled effectId
    **/
    let effectSettled

    // 多一层 cancel 包装，主要是为了 防止重复调用！！
    // Completion callback passed to the appropriate effect runner
    function currCb(res, isErr) {
      if (effectSettled) {
        return
      }

      effectSettled = true
      cb.cancel = noop // defensive measure
      if (sagaMonitor) {
        isErr ? sagaMonitor.effectRejected(effectId, res) : sagaMonitor.effectResolved(effectId, res)
      }
      if (isErr) {
        crashedEffect = effect
      }
      // 传递给 next()
      cb(res, isErr)
    }
    // tracks down the current cancel
    // 默认值
    currCb.cancel = noop

    // setup cancellation logic on the parent cb
    // 即：next.cancel 动态变化 变成 currCb.cancel 动态变化
    // 用于 cancel 当前正在执行的 effect
    cb.cancel = () => {
      // prevents cancelling an already completed effect
      if (effectSettled) {
        return
      }

      effectSettled = true
      /**
        propagates cancel downward
        catch uncaught cancellations errors; since we can no longer call the completion
        callback, log errors raised during cancellations into the console
      **/
      try {
        // 执行 各个 effect 对应的 cancel 方法
        currCb.cancel()
      } catch (err) {
        logError(err)
      }
      currCb.cancel = noop // defensive measure

      sagaMonitor && sagaMonitor.effectCancelled(effectId)
    }

    // if one can find a way to decouple runEffect from closure variables
    // so it could be the call to it could be referentially transparent
    // this potentially could be simplified, finalRunEffect created beforehand
    // and this part of the code wouldnt have to know about middleware stuff
    // saga effect
    // middle compose!!!!
    // function middleware(next) {
    //   return function (effect) {
    //     console.log(1111);
    //     next(effect);
    //   }
    // }
    // saga effect middleware 对 effect 进行处理
    // 最后，可选择性交给 runEffect 处理
    if (is.func(middleware)) {
      middleware(eff => runEffect(eff, effectId, currCb))(effect)
      return
    }

    runEffect(effect, effectId, currCb)
  }

  function resolvePromise(promise, cb) {
    // promise effect runner 提供 cancel方法，用于 取消 `异步` 操作 (如：ajax)
    const cancelPromise = promise[CANCEL]
    if (is.func(cancelPromise)) {
      cb.cancel = cancelPromise
    } else if (is.func(promise.abort)) {
      cb.cancel = () => promise.abort()
    }
    promise.then(cb, error => cb(error, true))
  }

  function resolveIterator(iterator, effectId, meta, cb) {
    proc(iterator, stdChannel, dispatch, getState, taskContext, options, effectId, meta, cb)
  }

  function runTakeEffect({ channel = stdChannel, pattern, maybe }, cb) {
    const takeCb = input => {
      if (input instanceof Error) {
        cb(input, true)
        return
      }
      if (isEnd(input) && !maybe) {
        cb(CHANNEL_END)
        return
      }
      cb(input)
    }
    try {
      // 向 channel 注册回调，然后 generation funciton 等待 用户 input action (dispatch) 的到来
      channel.take(takeCb, is.notUndef(pattern) ? matcher(pattern) : null)
    } catch (err) {
      cb(err, true)
      return
    }
    cb.cancel = takeCb.cancel
  }

  function runPutEffect({ channel, action, resolve }, cb) {
    /**
      Schedule the put in case another saga is holding a lock.
      The put will be executed atomically. ie nested puts will execute after
      this put has terminated.
    **/
    // 保证当前 put 回调里面的代码执行完毕
    // 嵌套的情况下，当前input也是最先执行完毕
    asap(() => {
      let result
      try {
        result = (channel ? channel.put : dispatch)(action)
      } catch (error) {
        cb(error, true)
        return
      }
      // 针对 dispatch 返回结果为 promise 的情况，比如使用了：redux-promise
      if (resolve && is.promise(result)) {
        resolvePromise(result, cb)
      } else {
        cb(result)
        return
      }
    })
    // Put effects are non cancellables
  }

  function runCallEffect({ context, fn, args }, effectId, cb) {
    let result
    // catch synchronous failures; see #152
    try {
      result = fn.apply(context, args)
    } catch (error) {
      cb(error, true)
      return
    }
    // fn 可能是一个 generator function -> iterator
    // 普通函数，返回值：promise | 普通返回值
    return is.promise(result)
      ? resolvePromise(result, cb)
      : is.iterator(result) ? resolveIterator(result, effectId, getMetaInfo(fn), cb) : cb(result)
  }

  function runCPSEffect({ context, fn, args }, cb) {
    // CPS (ie node style functions) can define their own cancellation logic
    // by setting cancel field on the cb

    // catch synchronous failures; see #152
    try {
      const cpsCb = (err, res) => (is.undef(err) ? cb(res) : cb(err, true))
      fn.apply(context, args.concat(cpsCb))
      if (cpsCb.cancel) {
        cb.cancel = () => cpsCb.cancel()
      }
    } catch (error) {
      cb(error, true)
      return
    }
  }

  function runForkEffect({ context, fn, args, detached }, effectId, cb) {
    // 将 fn 封装成 iterator
    // 这是 proc 函数 iterate over 时 所需要的
    // Note: 这里支持 normal function
    const taskIterator = createTaskIterator({ context, fn, args })
    const meta = getIteratorMetaInfo(taskIterator, fn)
    try {
      suspend() // 保证 fork 的异步操作，现将相关的put操作压入队列，保证主干的 put 操作优先执行
      const task = proc(
        taskIterator,
        stdChannel,
        dispatch,
        getState,
        taskContext,
        options,
        effectId,
        meta,
        detached ? null : noop, // 分离 task，cont 方法 置为空
      )

      // cb(task) 回传 task object，后台运行
      // 此时同时保证，parent generator 继续运行，非阻塞（也就是 resume）
      // 如：const task = yield fork(function* () { ... });
      // task.cancel();
      if (detached) {
        cb(task) // 分离的 task，没有就加入到 taskQueue
      } else {
        if (taskIterator._isRunning) {
          // 子 task 关联
          taskQueue.addTask(task)
          cb(task)
        } else if (taskIterator._error) {
          taskQueue.abort(taskIterator._error)
        } else {
          cb(task)
        }
      }
    } finally {
      flush()
    }
    // fork effect 是独立执行的，非阻塞的，所以 不可以被 cancel 的
    // Fork effects are non cancellables
  }

  function runJoinEffect(t, cb) {
    if (t.isRunning()) {
      const joiner = { task, cb }
      cb.cancel = () => remove(t.joiners, joiner)
      t.joiners.push(joiner)
    } else {
      t.isAborted() ? cb(t.error(), true) : cb(t.result())
    }
  }

  function runCancelEffect(taskToCancel, cb) {
    if (taskToCancel === SELF_CANCELLATION) {
      taskToCancel = task
    }
    if (taskToCancel.isRunning()) {
      taskToCancel.cancel()
    }
    cb()
    // cancel effects are non cancellables
  }

  function runAllEffect(effects, effectId, cb) {
    const keys = Object.keys(effects)

    if (!keys.length) {
      cb(is.array(effects) ? [] : {})
      return
    }

    let completedCount = 0
    let completed
    const results = {}
    const childCbs = {}

    function checkEffectEnd() {
      if (completedCount === keys.length) {
        completed = true
        cb(is.array(effects) ? array.from({ ...results, length: keys.length }) : results)
      }
    }

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if (completed) {
          return
        }
        if (isErr || isEnd(res) || res === CHANNEL_END || res === TASK_CANCEL) {
          cb.cancel()
          cb(res, isErr)
        } else {
          results[key] = res
          completedCount++
          checkEffectEnd()
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      if (!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }

    keys.forEach(key => digestEffect(effects[key], effectId, key, childCbs[key]))
  }

  function runRaceEffect(effects, effectId, cb) {
    let completed
    const keys = Object.keys(effects)
    const childCbs = {}

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if (completed) {
          return
        }

        if (isErr) {
          // Race Auto cancellation
          cb.cancel()
          cb(res, true)
        } else if (!isEnd(res) && res !== CHANNEL_END && res !== TASK_CANCEL) {
          cb.cancel()
          completed = true
          const response = { [key]: res }
          cb(is.array(effects) ? [].slice.call({ ...response, length: keys.length }) : response)
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      // prevents unnecessary cancellation
      if (!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }
    keys.forEach(key => {
      if (completed) {
        return
      }
      digestEffect(effects[key], effectId, key, childCbs[key])
    })
  }

  function runSelectEffect({ selector, args }, cb) {
    try {
      const state = selector(getState(), ...args)
      cb(state)
    } catch (error) {
      cb(error, true)
    }
  }

  function runChannelEffect({ pattern, buffer }, cb) {
    // TODO: rethink how END is handled
    const chan = channel(buffer)
    const match = matcher(pattern)

    const taker = action => {
      if (!isEnd(action)) {
        stdChannel.take(taker, match)
      }
      chan.put(action)
    }

    stdChannel.take(taker, match)
    cb(chan)
  }

  function runCancelledEffect(data, cb) {
    cb(!!mainTask.isCancelled)
  }

  function runFlushEffect(channel, cb) {
    channel.flush(cb)
  }

  function runGetContextEffect(prop, cb) {
    cb(taskContext[prop])
  }

  function runSetContextEffect(props, cb) {
    object.assign(taskContext, props)
    cb()
  }

  // 为 saga generator 创建一个 task descriptor
  function newTask(id, meta, iterator, cont) {
    iterator._deferredEnd = null
    return {
      [TASK]: true,
      id,
      meta,
      toPromise() {
        // iterator 迭代器 支持 promise
        if (iterator._deferredEnd) {
          return iterator._deferredEnd.promise
        }

        const def = deferred()
        iterator._deferredEnd = def

        if (!iterator._isRunning) {
          if (iterator._isAborted) {
            def.reject(iterator._error)
          } else {
            def.resolve(iterator._result)
          }
        }

        return def.promise
      },
      cont,
      joiners: [],
      cancel,
      isRunning: () => iterator._isRunning,
      isCancelled: () => iterator._isCancelled,
      isAborted: () => iterator._isAborted,
      result: () => iterator._result,
      error: () => iterator._error,
      // 动态设置 task context
      setContext(props) {
        if (process.env.NODE_ENV === 'development') {
          check(props, is.object, createSetContextWarning('task', props))
        }

        object.assign(taskContext, props)
      },
    }
  }
}
