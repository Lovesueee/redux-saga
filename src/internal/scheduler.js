// 任务队列
// 这里主要是为了让任务按顺序，尽可能快的执行
const queue = []
/**
  Variable to hold a counting semaphore
  - Incrementing adds a lock and puts the scheduler in a `suspended` state (if it's not
    already suspended)
  - Decrementing releases a lock. Zero locks puts the scheduler in a `released` state. This
    triggers flushing the queued tasks.
**/
// 信号量
// 0: 表示：空闲，可以立马执行任务
// >=1： 表示：挂起，任务压缩队列，等候执行
let semaphore = 0

/**
  Executes a task 'atomically'. Tasks scheduled during this execution will be queued
  and flushed after this task has finished (assuming the scheduler endup in a released
  state).
**/
// 原子操作，只执行当前task
// 用于嵌套的情况，详见 scheduler 的 test 用例
function exec(task) {
  try {
    suspend()
    task()
  } finally {
    release()
  }
}

/**
  Executes or queues a task depending on the state of the scheduler (`suspended` or `released`)
**/
export function asap(task) {
  // task 放入队列中
  queue.push(task)

  // 当前队列处于空闲状态
  // 执行任务
  if (!semaphore) {
    suspend()
    flush()
  }
}

/**
  Puts the scheduler in a `suspended` state. Scheduled tasks will be queued until the
  scheduler is released.
**/
// 队列处于 暂停或挂起 状态
// 用信号量控制
export function suspend() {
  semaphore++
}

/**
  Puts the scheduler in a `released` state.
**/
// 队列处于 空闲状态
function release() {
  semaphore--
}

/**
  Releases the current lock. Executes all queued tasks if the scheduler is in the released state.
**/
export function flush() {
  release()

  let task
  while (!semaphore && (task = queue.shift()) !== undefined) {
    exec(task)
  }
}
