import { is, check, object, createSetContextWarning } from './utils'
import { stdChannel } from './channel'
import { identity } from './utils'
import { runSaga } from './runSaga'

// 返回的是一个sagaMiddle Factory
// 似乎这里在创建 sagaMiddle 的时候可以进行一定的配置
export default function sagaMiddlewareFactory({ context = {}, ...options } = {}) {
  const { sagaMonitor, logger, onError, effectMiddlewares } = options

  // 开发环境，做一些 options 字段类型校验，很稳！！
  if (process.env.NODE_ENV === 'development') {
    if (is.notUndef(logger)) {
      check(logger, is.func, 'options.logger passed to the Saga middleware is not a function!')
    }

    if (is.notUndef(onError)) {
      check(onError, is.func, 'options.onError passed to the Saga middleware is not a function!')
    }

    if (is.notUndef(options.emitter)) {
      check(options.emitter, is.func, 'options.emitter passed to the Saga middleware is not a function!')
    }
  }

  // 真正的 saga middleware
  // 接收来自 redux 的形参对象 { getState, dispatch }
  function sagaMiddleware({ getState, dispatch }) {
    // channel 对象，贯穿整个应用
    const channel = stdChannel()
    // options.emitter 是对 channel.put 的 high order function 包装
    // 这里是提供用户层面的包装
    channel.put = (options.emitter || identity)(channel.put)

    // redux applyMiddle 配置中间件时，
    // 会重新赋值 run 方法。
    // 用户也可以直接调用 runSaga(options, saga, ...args);
    // 用户使用 sagaMiddleware.run() 就可以省略传递 options
    // 启动 saga
    // runSaga 可多次调用，用用动态加载 saga 的时候
    sagaMiddleware.run = runSaga.bind(null, {
      // options
      context,
      channel, // 整个应用大概就共用这一个 channel
      dispatch,
      getState,
      sagaMonitor,
      logger,
      onError,
      effectMiddlewares,
    })

    return next => action => {
      // 我猜：主要用于 saga 监控吧？配置项，用于development环境下
      if (sagaMonitor && sagaMonitor.actionDispatched) {
        sagaMonitor.actionDispatched(action)
      }
      // 执行 base store.dispatch，执行 reducer，获取最新的 state
      // 意思是：redux-saga 一定是最后一个redux middleware?
      // 所以这的 result 一定是 action 本身
      // 这里的 action 分为两种：一种是纯粹的 action，另一种是 saga action

      // 纯粹的 action 经过 reducer
      const result = next(action) // hit reducers
      // saga action，即：通过 yield put(action) 生成
      // 向 saga 发送 action
      // monitor saga 往往会在这之前先进行 channel.take() 注册！
      channel.put(action)
      return result
    }
  }

  // 这里是提醒，用户在使用 sagaMiddleware.run(...) 的时候，确保 redux-saga 中间件 已经被挂在在 redux 上。
  // 如果挂载了的话，sagaMiddleware.run 就会被重写（详见上面）
  // 因为 root saga 中可能会存在 saga put(action) 或者 store.dispatch(action) 操作，如果没有 applyMiddle 的话，action 将不会传递给 saga middleware
  sagaMiddleware.run = () => {
    throw new Error('Before running a Saga, you must mount the Saga middleware on the Store using applyMiddleware')
  }

  // 动态改变 middleware context
  // 初始化为 options.context
  sagaMiddleware.setContext = props => {
    if (process.env.NODE_ENV === 'development') {
      check(props, is.object, createSetContextWarning('sagaMiddleware', props))
    }

    object.assign(context, props)
  }

  return sagaMiddleware
}
