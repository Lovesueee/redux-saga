/* eslint-disable no-constant-condition */

import { put, takeEvery, delay } from '../../../../src/effects'

let i = 1;
export function* incrementAsync() {
  yield delay(1000)

  if (i % 2 == 0) {
    i++;
    console.log(xxx);
  } else {
    i++;
    console.log(i);
  }


  yield put({type: 'INCREMENT'})
}

export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', incrementAsync)
}

