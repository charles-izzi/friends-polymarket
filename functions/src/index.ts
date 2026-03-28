import { setGlobalOptions } from 'firebase-functions'
import { onCall, HttpsError } from 'firebase-functions/https'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as crypto from 'crypto'
import { calcCost, calcPrices } from './lmsr'

initializeApp()
const db = getFirestore(process.env.FIRESTORE_DATABASE || 'staging')

setGlobalOptions({ maxInstances: 10 })

function generateInviteCode(): string {
  return crypto.randomBytes(4).toString('hex')
}

export const createServer = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { name } = request.data as { name: string }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Server name is required')
  }

  // Check user isn't already in a server
  const existing = await db.collectionGroup('members').where('userId', '==', uid).limit(1).get()
  if (!existing.empty) {
    throw new HttpsError('already-exists', 'You are already in a server')
  }

  const inviteCode = generateInviteCode()
  const serverRef = db.collection('servers').doc()

  const batch = db.batch()
  batch.set(serverRef, {
    name: name.trim(),
    ownerId: uid,
    inviteCode,
    defaultBalance: 1000,
    liquidityParam: 100,
    createdAt: FieldValue.serverTimestamp(),
  })
  batch.set(serverRef.collection('members').doc(uid), {
    userId: uid,
    displayName: request.auth?.token.name || request.auth?.token.email || 'Anonymous',
    photoURL: request.auth?.token.picture || null,
    balance: 1000,
    joinedAt: FieldValue.serverTimestamp(),
  })

  await batch.commit()
  return { serverId: serverRef.id, inviteCode }
})

export const joinServer = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { inviteCode } = request.data as { inviteCode: string }
  if (!inviteCode || typeof inviteCode !== 'string') {
    throw new HttpsError('invalid-argument', 'Invite code is required')
  }

  // Check user isn't already in a server
  const existing = await db.collectionGroup('members').where('userId', '==', uid).limit(1).get()
  if (!existing.empty) {
    throw new HttpsError('already-exists', 'You are already in a server')
  }

  // Find server by invite code
  const serversSnap = await db
    .collection('servers')
    .where('inviteCode', '==', inviteCode.trim())
    .limit(1)
    .get()
  if (serversSnap.empty) {
    throw new HttpsError('not-found', 'Invalid invite code')
  }

  const serverDoc = serversSnap.docs[0]
  const serverData = serverDoc.data()

  await serverDoc.ref
    .collection('members')
    .doc(uid)
    .set({
      userId: uid,
      displayName: request.auth?.token.name || request.auth?.token.email || 'Anonymous',
      photoURL: request.auth?.token.picture || null,
      balance: serverData.defaultBalance,
      joinedAt: FieldValue.serverTimestamp(),
    })

  return { serverId: serverDoc.id }
})

export const createMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { serverId, question, type, outcomes, excludedMembers, closesAt } = request.data as {
    serverId: string
    question: string
    type: 'binary' | 'multiple_choice'
    outcomes: string[]
    excludedMembers: string[]
    closesAt: string // ISO string from client
  }

  // Validate inputs
  if (!serverId || !question?.trim()) {
    throw new HttpsError('invalid-argument', 'Server ID and question are required')
  }
  if (type !== 'binary' && type !== 'multiple_choice') {
    throw new HttpsError('invalid-argument', 'Type must be binary or multiple_choice')
  }
  if (!Array.isArray(outcomes) || outcomes.length < 2) {
    throw new HttpsError('invalid-argument', 'At least 2 outcomes are required')
  }
  if (outcomes.length > 10) {
    throw new HttpsError('invalid-argument', 'Maximum 10 outcomes allowed')
  }
  const closeDate = new Date(closesAt)
  if (isNaN(closeDate.getTime()) || closeDate.getTime() <= Date.now()) {
    throw new HttpsError('invalid-argument', 'Close date must be in the future')
  }

  // Verify user is a member of the server
  const memberDoc = await db
    .collection('servers')
    .doc(serverId)
    .collection('members')
    .doc(uid)
    .get()
  if (!memberDoc.exists) {
    throw new HttpsError('permission-denied', 'You are not a member of this server')
  }

  // Verify excluded members are actual members (if any)
  const sanitizedExcluded = (excludedMembers || []).filter(
    (id) => typeof id === 'string' && id.length > 0,
  )

  // Get server liquidity param
  const serverDoc = await db.collection('servers').doc(serverId).get()
  if (!serverDoc.exists) {
    throw new HttpsError('not-found', 'Server not found')
  }
  const liquidityParam = serverDoc.data()!.liquidityParam || 100

  const marketRef = db.collection('servers').doc(serverId).collection('markets').doc()

  await marketRef.set({
    question: question.trim(),
    type,
    outcomes: outcomes.map((o) => o.trim()),
    createdBy: uid,
    excludedMembers: sanitizedExcluded,
    status: 'open',
    resolvedOutcome: null,
    closesAt: Timestamp.fromDate(closeDate),
    createdAt: FieldValue.serverTimestamp(),
    liquidityParam,
    sharesSold: new Array(outcomes.length).fill(0),
  })

  return { marketId: marketRef.id }
})

export const executeTrade = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { serverId, marketId, outcomeIndex, shares } = request.data as {
    serverId: string
    marketId: string
    outcomeIndex: number
    shares: number // positive = buy, negative = sell
  }

  if (!serverId || !marketId) {
    throw new HttpsError('invalid-argument', 'Server ID and market ID are required')
  }
  if (typeof outcomeIndex !== 'number' || typeof shares !== 'number' || shares === 0) {
    throw new HttpsError('invalid-argument', 'Valid outcome index and non-zero shares required')
  }

  const serverRef = db.collection('servers').doc(serverId)
  const marketRef = serverRef.collection('markets').doc(marketId)
  const memberRef = serverRef.collection('members').doc(uid)
  const positionRef = marketRef.collection('positions').doc(uid)

  const result = await db.runTransaction(async (txn) => {
    const [marketSnap, memberSnap, positionSnap] = await Promise.all([
      txn.get(marketRef),
      txn.get(memberRef),
      txn.get(positionRef),
    ])

    if (!marketSnap.exists) {
      throw new HttpsError('not-found', 'Market not found')
    }
    if (!memberSnap.exists) {
      throw new HttpsError('permission-denied', 'You are not a member of this server')
    }

    const market = marketSnap.data()!
    const member = memberSnap.data()!

    // Validate market is open and not past close time
    if (market.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Market is not open for trading')
    }
    if (market.closesAt.toDate().getTime() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'Market has closed')
    }

    // Check user is not excluded
    if (market.excludedMembers && market.excludedMembers.includes(uid)) {
      throw new HttpsError('permission-denied', 'You are excluded from this market')
    }

    // Validate outcome index
    if (outcomeIndex < 0 || outcomeIndex >= market.outcomes.length) {
      throw new HttpsError('invalid-argument', 'Invalid outcome index')
    }

    const sharesSold: number[] = market.sharesSold
    const b: number = market.liquidityParam

    // Get current position
    const position = positionSnap.exists
      ? positionSnap.data()!
      : { shares: new Array(market.outcomes.length).fill(0), totalCost: 0 }

    // For sells, verify user has enough shares
    if (shares < 0) {
      const currentShares = position.shares[outcomeIndex] ?? 0
      if (currentShares < Math.abs(shares)) {
        throw new HttpsError(
          'failed-precondition',
          `Insufficient shares. You have ${currentShares}, trying to sell ${Math.abs(shares)}`,
        )
      }
    }

    // Calculate cost via LMSR
    const cost = calcCost(sharesSold, outcomeIndex, shares, b)

    // For buys, verify user has enough balance
    if (cost > 0 && member.balance < cost) {
      throw new HttpsError(
        'failed-precondition',
        `Insufficient balance. Cost: ${cost.toFixed(2)}, balance: ${member.balance.toFixed(2)}`,
      )
    }

    // Update market sharesSold
    const newSharesSold = [...sharesSold]
    newSharesSold[outcomeIndex] = (newSharesSold[outcomeIndex] ?? 0) + shares
    txn.update(marketRef, { sharesSold: newSharesSold })

    // Update member balance
    txn.update(memberRef, { balance: member.balance - cost })

    // Update position
    const newShares = [...position.shares]
    newShares[outcomeIndex] = (newShares[outcomeIndex] ?? 0) + shares
    txn.set(positionRef, {
      userId: uid,
      shares: newShares,
      totalCost: position.totalCost + cost,
    })

    // Record trade
    const priceAfter = calcPrices(newSharesSold, b)
    const tradeRef = marketRef.collection('trades').doc()
    txn.set(tradeRef, {
      userId: uid,
      outcomeIndex,
      shares,
      cost,
      priceAfter,
      createdAt: FieldValue.serverTimestamp(),
    })

    return {
      tradeId: tradeRef.id,
      cost,
      newBalance: member.balance - cost,
      priceAfter,
    }
  })

  return result
})

export const resolveMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { serverId, marketId, outcomeIndex } = request.data as {
    serverId: string
    marketId: string
    outcomeIndex: number
  }

  if (!serverId || !marketId || typeof outcomeIndex !== 'number') {
    throw new HttpsError('invalid-argument', 'Server ID, market ID, and outcome index are required')
  }

  const serverRef = db.collection('servers').doc(serverId)
  const marketRef = serverRef.collection('markets').doc(marketId)

  await db.runTransaction(async (txn) => {
    const marketSnap = await txn.get(marketRef)
    if (!marketSnap.exists) {
      throw new HttpsError('not-found', 'Market not found')
    }

    const market = marketSnap.data()!

    // Only the creator can resolve
    if (market.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Only the bet creator can resolve this market')
    }

    if (market.status !== 'open' && market.status !== 'closed') {
      throw new HttpsError('failed-precondition', 'Market is already resolved or cancelled')
    }

    if (outcomeIndex < 0 || outcomeIndex >= market.outcomes.length) {
      throw new HttpsError('invalid-argument', 'Invalid outcome index')
    }

    // Update market status
    txn.update(marketRef, {
      status: 'resolved',
      resolvedOutcome: outcomeIndex,
    })

    // Get all positions and credit winners
    const positionsSnap = await txn.get(marketRef.collection('positions'))
    for (const posDoc of positionsSnap.docs) {
      const pos = posDoc.data()
      const winningShares: number = pos.shares[outcomeIndex] ?? 0
      if (winningShares > 0) {
        // Each winning share pays out 1 coin
        const memberRef = serverRef.collection('members').doc(posDoc.id)
        const memberSnap = await txn.get(memberRef)
        if (memberSnap.exists) {
          const currentBalance: number = memberSnap.data()!.balance
          txn.update(memberRef, { balance: currentBalance + winningShares })
        }
      }
    }
  })

  return { success: true }
})

export const cancelMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { serverId, marketId } = request.data as {
    serverId: string
    marketId: string
  }

  if (!serverId || !marketId) {
    throw new HttpsError('invalid-argument', 'Server ID and market ID are required')
  }

  const serverRef = db.collection('servers').doc(serverId)
  const marketRef = serverRef.collection('markets').doc(marketId)

  await db.runTransaction(async (txn) => {
    const marketSnap = await txn.get(marketRef)
    if (!marketSnap.exists) {
      throw new HttpsError('not-found', 'Market not found')
    }

    const market = marketSnap.data()!

    // Only the creator can cancel
    if (market.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Only the bet creator can cancel this market')
    }

    if (market.status === 'resolved' || market.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'Market is already resolved or cancelled')
    }

    // Update market status
    txn.update(marketRef, {
      status: 'cancelled',
      resolvedOutcome: null,
    })

    // Refund all positions at cost basis
    const positionsSnap = await txn.get(marketRef.collection('positions'))
    for (const posDoc of positionsSnap.docs) {
      const pos = posDoc.data()
      const refundAmount: number = pos.totalCost
      if (refundAmount > 0) {
        const memberRef = serverRef.collection('members').doc(posDoc.id)
        const memberSnap = await txn.get(memberRef)
        if (memberSnap.exists) {
          const currentBalance: number = memberSnap.data()!.balance
          txn.update(memberRef, { balance: currentBalance + refundAmount })
        }
      }
    }
  })

  return { success: true }
})
