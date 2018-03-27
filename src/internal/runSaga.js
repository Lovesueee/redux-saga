import { compose } from 'redux'
import { is, check, uid as nextSagaId, wrapSagaDispatch, noop } from './utils'
import proc, { getMetaInfo } from './proc'
import { stdChannel } from './channel'

const RUN_SAGA_SIGNATURE = 'runSaga(options, saga, ...args)'
const NON_GENERATOR_ERR = `${RUN_SAGA_SIGNATURE}: saga argument must be a Generator function!`

// options: saga options
// createSagaMiddle(options)
export function runSaga(options, saga, ...args) {
  // rootSaga 也可以是纯函数？
  if (process.env.NODE_ENV === 'development') {
    check(saga, is.func, NON_GENERATOR_ERR)
  }

  // 执行 saga（generation function），返回 generator (也就是 iterator)
  // note: args 传递给 saga task!，一般用于 saga 作为 generaor function 被重复利用的场景
  const iterator = saga(...args)

  if (process.env.NODE_ENV === 'development') {
    check(iterator, is.iterator, NON_GENERATOR_ERR)
  }

  const {
    channel = stdChannel(),
    dispatch,
    getState,
    context,
    sagaMonitor,
    logger,
    effectMiddlewares,
    onError,
  } = options

  // 返回 一个 id，从1开始，递增
  const effectId = nextSagaId()

  // 先忽略 monitor(开发者一般用不上这个)
  if (sagaMonitor) {
    // monitors are expected to have a certain interface, let's fill-in any missing ones
    sagaMonitor.effectTriggered = sagaMonitor.effectTriggered || noop
    sagaMonitor.effectResolved = sagaMonitor.effectResolved || noop
    sagaMonitor.effectRejected = sagaMonitor.effectRejected || noop
    sagaMonitor.effectCancelled = sagaMonitor.effectCancelled || noop
    sagaMonitor.actionDispatched = sagaMonitor.actionDispatched || noop

    sagaMonitor.effectTriggered({ effectId, root: true, parentEffectId: 0, effect: { root: true, saga, args } })
  }

  if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && is.notUndef(effectMiddlewares)) {
    const MIDDLEWARE_TYPE_ERROR = 'effectMiddlewares must be an array of functions'
    check(effectMiddlewares, is.array, MIDDLEWARE_TYPE_ERROR)
    effectMiddlewares.forEach(effectMiddleware => check(effectMiddleware, is.func, MIDDLEWARE_TYPE_ERROR))
  }

  // saga 自身的 middleware?
  // function middleware(next) {
  //   return function (action) {
  //     console.log(1111);
  //     next(action);
  //   }
  // }
  const middleware = effectMiddlewares && compose(...effectMiddlewares)

  // 处理 rootSaga!! 入口
  const task = proc(
    iterator,
    channel,
    wrapSagaDispatch(dispatch), // dispatch 的高阶封装，会在每一个 action 标记为 SAGA_ACTION
    getState,
    context,
    { sagaMonitor, logger, onError, middleware },
    effectId,
    getMetaInfo(saga),
  )

  if (sagaMonitor) {
    sagaMonitor.effectResolved(effectId, task)
  }

  return task
}
