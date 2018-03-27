import fsmIterator, { qEnd, safeName } from './fsmIterator'
import { take, fork } from '../io'
import { END } from '../channel'

export default function takeEvery(patternOrChannel, worker, ...args) {
  const yTake = { done: false, value: take(patternOrChannel) }
  const yFork = ac => ({ done: false, value: fork(worker, ...args, ac) })

  let action,
    setAction = ac => (action = ac)

  // 模拟 generator
  // A finite state machine iterator
  // 有限状态机迭代器
  return fsmIterator(
    {
      q1() {
        return ['q2', yTake, setAction] // setAction(action) => action = take('actionName')
      },
      q2() {
        return action === END ? [qEnd] : ['q1', yFork(action)]
      },
    },
    'q1',
    `takeEvery(${safeName(patternOrChannel)}, ${worker.name})`,
  )
}
