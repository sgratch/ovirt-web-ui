import {
  call,
  put,
  select,
} from 'redux-saga/effects'

import AppConfiguration from '_/config'
import { hidePassword } from '_/helpers'
import { msg } from '_/intl'
import Api from '_/ovirtapi'
import { getUserPermits } from '_/utils'

import {
  checkTokenExpired,
  failedExternalAction,
  showTokenExpiredMessage,
} from '_/actions'

/**
 * Resolve a promise after the given delay (in milliseconds)
 */
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Compare the actual { major, minor } version to the required { major, minor } and
 * return if the **actual** is greater then or equal to **required**.
 *
 * Backward compatibility of the API is assumed.
 */
export function compareVersion (actual, required) {
  console.log(`compareVersion(), actual=${JSON.stringify(actual)}, required=${JSON.stringify(required)}`)

  if (actual.major >= required.major) {
    if (actual.major === required.major) {
      if (actual.minor < required.minor) {
        return false
      }
    }
    return true
  }
  return false
}

export function* callExternalAction (methodName, method, action = {}, canBeMissing = false) {
  try {
    console.log(`External action: ${JSON.stringify(hidePassword({ action }))}, API method: ${methodName}()`)
    const result = yield call(method, action.payload || {})
    return result
  } catch (e) {
    if (!canBeMissing) {
      console.log(`External action exception: ${JSON.stringify(e)}`)

      if (e.status === 401) { // Unauthorized
        yield put(checkTokenExpired())
      }

      let shortMessage = shortErrorMessage({ action })
      if (e.status === 0 && e.statusText === 'error') { // special case, mixing https and http
        shortMessage = 'oVirt API connection failed'
        e.statusText = 'Unable to connect to oVirt REST API. Please check URL and protocol (https).'
      }

      yield put(failedExternalAction({
        exception: e,
        shortMessage,
        failedAction: action,
      }))
    }
    return { error: e }
  }
}

export function* doCheckTokenExpired (action) {
  try {
    yield call(Api.getOvirtApiMeta, action.payload)
    console.info('doCheckTokenExpired(): token is still valid') // info level: to pair former HTTP 401 error message with updated information
    return
  } catch (error) {
    if (error.status === 401) {
      console.info('Token expired, going to reload the page')
      yield put(showTokenExpiredMessage())

      // Reload the page after a delay
      // No matter saga is canceled for whatever reason, the reload must happen, so here comes the ugly setTimeout()
      setTimeout(() => {
        console.info('======= doCheckTokenExpired() issuing page reload')
        window.location.href = AppConfiguration.applicationURL
      }, 5 * 1000)
      return
    }
    console.error('doCheckTokenExpired(): unexpected oVirt API error: ', error)
  }
}

// TODO: Can't this be replaced by saga's blocking put.resolve()?
export function* waitTillEqual (leftArg, rightArg, limit) {
  let counter = limit

  const left = typeof leftArg === 'function' ? leftArg : () => leftArg
  const right = typeof rightArg === 'function' ? rightArg : () => rightArg

  while (counter > 0) {
    if (left() === right()) {
      return true
    }
    yield delay(20) // in ms
    counter--

    console.log('waitTillEqual() delay ...')
  }

  return false
}

const shortMessages = {
  'START_VM': msg.failedToStartVm(),
  'RESTART_VM': msg.failedToRestartVm(),
  'SHUTDOWN_VM': msg.failedToShutdownVm(),
  'DOWNLOAD_CONSOLE_VM': msg.failedToGetVmConsole(),
  'SUSPEND_VM': msg.failedToSuspendVm(),
  'REMOVE_VM': msg.failedToRemoveVm(),

  'GET_ICON': msg.failedToRetrieveVmIcon(),
  'INTERNAL_CONSOLE': msg.failedToRetrieveVmConsoleDetails(),
  'INTERNAL_CONSOLES': msg.failedToRetrieveListOfVmConsoles(),
  'GET_DISK_DETAILS': msg.failedToRetrieveDiskDetails(),
  'GET_DISK_ATTACHMENTS': msg.failedToRetrieveVmDisks(),
  'GET_ISO_FILES': msg.failedToRetrieveIsoStorages(),

  'GET_VM': msg.failedToRetrieveVmDetails(),
  'CHANGE_VM_ICON': msg.failedToChangeVmIcon(),
  'CHANGE_VM_ICON_BY_ID': msg.failedToChangeVmIconToDefault(),
}

export function shortErrorMessage ({ action }) {
  return shortMessages[action.type] ? shortMessages[action.type] : msg.actionFailed({ action: action.type })
}

export function* foreach (array, fn, context) {
  var i = 0
  var length = array.length

  for (;i < length; i++) {
    yield * fn.call(context, array[i], i, array)
  }
}

/**
 * Generate a series of `count` numbers in a `2000 * log2` progression for use as a series
 * of millisecond delays. This is useful for progressively waiting a bit longer between
 * REST polling calls.
 *
 * @param {number} count Number of steps to generate, default to 20
 * @param {number} msMultiplier Millisecond multiplier at each step (each step will be at least
 *                              this big), default to 2000
 */
export function* delayInMsSteps (count = 20, msMultiplier = 2000) {
  for (let i = 2; i < (count + 2); i++) {
    yield Math.round(Math.log2(i) * msMultiplier)
  }
}

export function* fetchPermits ({ entityType, id }) {
  const permissions = yield callExternalAction(`get${entityType}Permissions`, Api[`get${entityType}Permissions`], { payload: { id } })
  return getUserPermits(Api.permissionsToInternal({ permissions: permissions.permission }))
}

export const PermissionsType = {
  DISK_TYPE: 'Disk',
}

/**
 * Convert a set of permissions to a set of permits for the app's current user by
 * mapping the permissions through their assigned roles to the permits.
 *
 * NOTE: If the user is an admin user the user's group and id membership must be
 * explicitly checked.
 */
export function* permissionsToUserPermits (permissions) {
  permissions = Array.isArray(permissions) ? permissions : [permissions]

  const userFilter = yield select(state => state.config.get('filter'))
  const userGroups = yield select(state => state.config.get('userGroups'))
  const userId = yield select(state => state.config.getIn(['user', 'id']))
  const roles = yield select(state => state.roles)

  const permitNames = []
  for (const permission of permissions) {
    if (userFilter ||
      (
        (permission.groupId && userGroups.includes(permission.groupId)) ||
        (permission.userId && permission.userId === userId)
      )
    ) {
      const role = roles.get(permission.roleId)
      if (!role) {
        console.info('Could find role in redux state, roleId:', permission.roleId)
      } else {
        permitNames.push(...role.get('permitNames', []))
      }
    }
  }

  return new Set(permitNames)
}
