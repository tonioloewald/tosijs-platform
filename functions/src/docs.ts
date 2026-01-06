/**
# /docs endpoint

## Required Parameters

- `p` (path) to collection

## Optional Parameters

- `c` (count) limits the number of records returned (default is 10)
- `f` (fields) comma-delimited list of fields to be returned
- `o` (order) is the sort field, e.g. `date` or `date(desc)`

## TODO
- `q` (query) a comma-delimited list of queries; will return a
  useful error if a required index is missing
*/

import { onRequest } from 'firebase-functions/v2/https'
import compression from 'compression'

import {
  optionsResponse,
  getUserRoles,
  AuthenticatedRequest,
} from './utilities'
import { collectionPath, getMethodAccess, ALL } from './collections/access'
import { COLLECTIONS } from './collections'
import { getRef } from './doc'
import { Response } from 'express'

const compressResponse = compression()

export async function getRecords(
  path: string,
  limit: number,
  order = '',
  fields = false as string[] | false
): Promise<Record<string, unknown>[]> {
  const refResult = await getRef(path, true)
  if (refResult instanceof Error) {
    return []
  }
  let ref = refResult as FirebaseFirestore.Query
  const records: Record<string, unknown>[] = []
  const [, field, direction] = order.match(/^(\w+)(\(asc\)|\(desc\))?$/) || [
    '',
    '',
  ]

  if (field) {
    ref = ref.orderBy(field, direction !== '(desc)' ? 'asc' : 'desc')
  }
  ref = ref.limit(limit)
  const snapshot = await (fields ? ref.select(...fields).get() : ref.get())

  // Extract the base collection path (without any field=value query)
  const baseCollectionPath = collectionPath(path)

  if (!snapshot.empty) {
    snapshot.forEach((doc) => {
      const _path = baseCollectionPath + '/' + doc.id
      records.push({ ...doc.data(), _path })
    })
  }
  return records
}

export const getDocs = async (
  req: AuthenticatedRequest,
  res: Response,
  path: string,
  limit = 10,
  fields: string[] | false = false,
  order = ''
): Promise<Record<string, unknown>[]> => {
  const userRoles = await getUserRoles(req)
  const access = getMethodAccess(
    COLLECTIONS,
    collectionPath(path),
    'LIST',
    userRoles,
    fields
  )

  if (access === ALL) {
    return await getRecords(path, limit, order, fields)
  } else if (typeof access === 'function') {
    let found = await getRecords(path, limit, order, fields)
    found = await Promise.all(found.map((rec) => access(rec, userRoles)))
    return found.filter((r) => !(r instanceof Error))
  } else {
    return []
  }
}

export const docs = onRequest({}, async (req, res) => {
  if (optionsResponse(req, res, ['GET'])) {
    return
  }

  const path = req.query.p as string
  const limit = Number(req.query.c) || 10
  const fields = req.query.f ? (req.query.f as string).split(',') : false
  const userRoles = await getUserRoles(req)
  const order = (req.query.o as string) || ''
  // const query = req.body.q as string
  const access = getMethodAccess(
    COLLECTIONS,
    collectionPath(path),
    'LIST',
    userRoles,
    fields
  )

  if (access === ALL) {
    const found = await getRecords(path, limit, order, fields)
    compressResponse(req, res, () => {
      res.json(found)
    })
  } else if (typeof access === 'function') {
    let found = await getRecords(path, limit, order, fields)
    found = await Promise.all(found.map((rec) => access(rec, userRoles)))
    compressResponse(req, res, () => {
      res.json(found.filter((r) => !(r instanceof Error)))
    })
  } else {
    res.status(403).send()
  }
})
