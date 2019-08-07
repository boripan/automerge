const { ROOT_ID, isObject, copyObject, parseElemId } = require('../src/common')
const { OPTIONS, OBJECT_ID, CONFLICTS, ELEM_IDS, MAX_ELEM } = require('./constants')
const { Text, instantiateText } = require('./text')
const { Table, instantiateTable } = require('./table')
const { Counter } = require('./counter')

/**
 * Reconstructs the value from the patch object `patch`.
 */
function getValue(patch, object, updated) {
  if (patch.objectId) {
    // If the objectId of the existing object does not match the objectId in the patch,
    // that means the patch is replacing the object with a new one made from scratch
    if (object && object[OBJECT_ID] !== patch.objectId) {
      object = undefined
    }
    return interpretPatch(patch, object, updated)
  } else if (patch.datatype === 'timestamp') {
    // Timestamp: value is milliseconds since 1970 epoch
    return new Date(patch.value)
  } else if (patch.datatype === 'counter') {
    return new Counter(patch.value)
  } else if (patch.datatype !== undefined) {
    throw new TypeError(`Unknown datatype: ${patch.datatype}`)
  } else {
    // Primitive value (number, string, boolean, or null)
    return patch.value
  }
}

/**
 * `props` is an object of the form:
 * `{key1: {actor1: {...}, actor2: {...}}, key2: {actor3: {...}}}`
 * where the outer object is a mapping from property names to inner objects,
 * and the inner objects are a mapping from actor ID to sub-patch.
 * This function interprets that structure and updates the objects `object` and
 * `conflicts` to reflect it. For each key, the lexicographically greatest
 * actor ID is chosen as the default resolution; that actor's value is assigned
 * to `object[key]`. Moreover, all the actor IDs and values are packed into a
 * conflicts object of the form `{actor1: value1, actor2: value2}` and assigned
 * to `conflicts[key]`. If there is no conflict, the conflicts object contains
 * just a single actor-value mapping.
 */
function applyProperties(props, object, conflicts, updated) {
  if (!props) return

  for (let key of Object.keys(props)) {
    const values = {}, actors = Object.keys(props[key]).sort().reverse()
    for (let actor of actors) {
      const subpatch = props[key][actor]
      if (conflicts[key] && conflicts[key][actor]) {
        values[actor] = getValue(subpatch, conflicts[key][actor], updated)
      } else {
        values[actor] = getValue(subpatch, undefined, updated)
      }
    }

    if (actors.length === 0) {
      delete object[key]
      delete conflicts[key]
    } else {
      object[key] = values[actors[0]]
      conflicts[key] = values
    }
  }
}

/**
 * `edits` is an array of edits to a list data structure, each of which is an
 * object of the form either `{action: 'insert', index, elemId}` or
 * `{action: 'remove', index, elemId}`. This merges adjacent edits and calls
 * `insertCallback(index, elemIds)` or `removeCallback(index, count)`, as
 * appropriate, for each sequence of insertions or removals.
 */
function iterateEdits(edits, insertCallback, removeCallback) {
  if (!edits) return
  let splicePos = -1, deletions, insertions

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i], action = edit.action, index = edit.index

    if (action === 'insert') {
      if (splicePos < 0) {
        splicePos = index
        deletions = 0
        insertions = []
      }
      insertions.push(edit.elemId)

      // If there are multiple consecutive insertions at successive indexes,
      // accumulate them and then process them in a single insertCallback
      if (i === edits.length - 1 ||
          edits[i + 1].action !== 'insert' ||
          edits[i + 1].index  !== index + 1) {
        insertCallback(splicePos, insertions)
        splicePos = -1
      }

    } else if (action === 'remove') {
      if (splicePos < 0) {
        splicePos = index
        deletions = 0
        insertions = []
      }
      deletions += 1

      // If there are multiple consecutive removals of the same index,
      // accumulate them and then process them in a single removeCallback
      if (i === edits.length - 1 ||
          edits[i + 1].action !== 'remove' ||
          edits[i + 1].index  !== index) {
        removeCallback(splicePos, deletions)
        splicePos = -1
      }
    } else {
      throw new RangeError(`Unknown list edit action: ${action}`)
    }
  }
}

/**
 * Creates a writable copy of an immutable map object. If `originalObject`
 * is undefined, creates an empty object with ID `objectId`.
 */
function cloneMapObject(originalObject, objectId) {
  const object    = copyObject(originalObject)
  const conflicts = copyObject(originalObject ? originalObject[CONFLICTS] : undefined)
  Object.defineProperty(object, OBJECT_ID, {value: objectId})
  Object.defineProperty(object, CONFLICTS, {value: conflicts})
  return object
}

/**
 * Updates the map object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateMapObject(patch, obj, updated) {
  const objectId = patch.objectId
  if (!updated[objectId]) {
    updated[objectId] = cloneMapObject(obj, objectId)
  }

  const object = updated[objectId]
  applyProperties(patch.props, object, object[CONFLICTS], updated)
  return object
}

/**
 * Updates the table object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateTableObject(patch, obj, updated) {
  const objectId = patch.objectId
  if (!updated[objectId]) {
    updated[objectId] = obj ? obj._clone() : instantiateTable(objectId)
  }

  const object = updated[objectId]

  for (let key of Object.keys(patch.props)) {
    const values = {}, actors = Object.keys(patch.props[key])

    if (actors.length === 0) {
      object.remove(key)
    } else if (actors.length === 1) {
      const subpatch = patch.props[key][actors[0]]
      object.set(key, getValue(subpatch, object.byId(key), updated), actors[0])
    } else {
      throw new RangeError('Conflicts are not supported on properties of a table')
    }
  }
  return object
}

/**
 * Creates a writable copy of an immutable list object. If `originalList` is
 * undefined, creates an empty list with ID `objectId`.
 */
function cloneListObject(originalList, objectId) {
  const list = originalList ? originalList.slice() : [] // slice() makes a shallow clone
  const conflicts = (originalList && originalList[CONFLICTS]) ? originalList[CONFLICTS].slice() : []
  const elemIds   = (originalList && originalList[ELEM_IDS ]) ? originalList[ELEM_IDS ].slice() : []
  const maxElem   = (originalList && originalList[MAX_ELEM] ) ? originalList[MAX_ELEM]          : 0
  Object.defineProperty(list, OBJECT_ID, {value: objectId})
  Object.defineProperty(list, CONFLICTS, {value: conflicts})
  Object.defineProperty(list, ELEM_IDS,  {value: elemIds})
  Object.defineProperty(list, MAX_ELEM,  {value: maxElem, writable: true})
  return list
}

/**
 * Updates the list object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateListObject(patch, obj, updated) {
  const objectId = patch.objectId
  if (!updated[objectId]) {
    updated[objectId] = cloneListObject(obj, objectId)
  }

  const list = updated[objectId], conflicts = list[CONFLICTS], elemIds = list[ELEM_IDS]
  list[MAX_ELEM] = Math.max(list[MAX_ELEM], patch.maxElem || 0)

  iterateEdits(patch.edits,
    (index, insertions) => { // insertion
      const blanks = new Array(insertions.length)
      list     .splice(index, 0, ...blanks)
      conflicts.splice(index, 0, ...blanks)
      elemIds  .splice(index, 0, ...insertions)
    },
    (index, count) => { // deletion
      list     .splice(index, count)
      conflicts.splice(index, count)
      elemIds  .splice(index, count)
    }
  )

  applyProperties(patch.props, list, conflicts, updated)
  return list
}

/**
 * Updates the text object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateTextObject(patch, obj, updated) {
  const objectId = patch.objectId
  let elems, maxElem
  if (updated[objectId]) {
    elems = updated[objectId].elems
    maxElem = updated[objectId][MAX_ELEM]
  } else if (obj) {
    elems = obj.elems.slice()
    maxElem = obj[MAX_ELEM]
  } else {
    elems = []
    maxElem = 0
  }

  maxElem = Math.max(maxElem, patch.maxElem || 0)

  iterateEdits(patch.edits,
    (index, insertions) => { // insertion
      elems.splice(index, 0, ...insertions.map(elemId => ({elemId})))
    },
    (index, deletions) => { // deletion
      elems.splice(index, deletions)
    }
  )

  for (let key of Object.keys(patch.props || {})) {
    const actor = Object.keys(patch.props[key]).sort().reverse()[0]
    if (!actor) throw new RangeError(`No default value at index ${key}`)

    // TODO Text object does not support conflicts. Should it?
    const oldValue = (elems[key].actorId === actor) ? elems[key].value : undefined
    elems[key].value = getValue(patch.props[key][actor], oldValue, updated)
    elems[key].actorId = actor
  }

  updated[objectId] = instantiateText(objectId, elems, maxElem)
  return updated[objectId]
}

/**
 * Applies the patch object `patch` to the read-only document object `obj`.
 * Clones a writable copy of `obj` and places it in `updated` (indexed by
 * objectId), if that has not already been done. Returns the updated object.
 */
function interpretPatch(patch, obj, updated) {
  // Return original object if it already exists and isn't being modified
  if (isObject(obj) && !patch.props && !patch.edits && !updated[patch.objectId]) {
    return obj
  }

  if (patch.type === 'map') {
    return updateMapObject(patch, obj, updated)
  } else if (patch.type === 'table') {
    return updateTableObject(patch, obj, updated)
  } else if (patch.type === 'list') {
    return updateListObject(patch, obj, updated)
  } else if (patch.type === 'text') {
    return updateTextObject(patch, obj, updated)
  } else {
    throw new TypeError(`Unknown object type: ${patch.type}`)
  }
}

/**
 * Creates a writable copy of the immutable document root object `root`.
 */
function cloneRootObject(root) {
  if (root[OBJECT_ID] !== ROOT_ID) {
    throw new RangeError(`Not the root object: ${root[OBJECT_ID]}`)
  }
  return cloneMapObject(root, ROOT_ID)
}

module.exports = {
  interpretPatch, cloneRootObject
}
