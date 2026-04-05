import { setGlobalOptions } from 'firebase-functions'
import { onCall, HttpsError } from 'firebase-functions/https'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as crypto from 'crypto'
import { calcCost, calcPrices, calcEffectiveB } from './lmsr'

initializeApp()

const ALLOWED_DBS = new Set(['staging', '(default)'])
const defaultDb = process.env.FIRESTORE_DATABASE || '(default)'

function getDb(database?: string) {
  const name = database && ALLOWED_DBS.has(database) ? database : defaultDb
  return name === '(default)' ? getFirestore() : getFirestore(name)
}

setGlobalOptions({ maxInstances: 10 })

function generateInviteCode(): string {
  return crypto.randomBytes(4).toString('hex')
}

export const createMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { name, database } = request.data as { name: string; database?: string }
  const db = getDb(database)
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Market name is required')
  }

  // Check user isn't already in a market
  const existing = await db.collectionGroup('members').where('userId', '==', uid).limit(1).get()
  if (!existing.empty) {
    throw new HttpsError('already-exists', 'You are already in a market')
  }

  const inviteCode = generateInviteCode()
  const marketRef = db.collection('markets').doc()

  const batch = db.batch()
  batch.set(marketRef, {
    name: name.trim(),
    ownerId: uid,
    inviteCode,
    defaultBalance: 0,
    liquidityParam: 100,
    createdAt: FieldValue.serverTimestamp(),
  })
  batch.set(marketRef.collection('members').doc(uid), {
    userId: uid,
    displayName: request.auth?.token.name || request.auth?.token.email || 'Anonymous',
    photoURL: request.auth?.token.picture || null,
    balance: 0,
    joinedAt: FieldValue.serverTimestamp(),
  })

  await batch.commit()
  return { marketId: marketRef.id, inviteCode }
})

export const joinMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { inviteCode, database } = request.data as { inviteCode: string; database?: string }
  const db = getDb(database)
  if (!inviteCode || typeof inviteCode !== 'string') {
    throw new HttpsError('invalid-argument', 'Invite code is required')
  }

  // Check user isn't already in a market
  const existing = await db.collectionGroup('members').where('userId', '==', uid).limit(1).get()
  if (!existing.empty) {
    throw new HttpsError('already-exists', 'You are already in a market')
  }

  // Find market by invite code
  const marketsSnap = await db
    .collection('markets')
    .where('inviteCode', '==', inviteCode.trim())
    .limit(1)
    .get()
  if (marketsSnap.empty) {
    throw new HttpsError('not-found', 'Invalid invite code')
  }

  const marketDoc = marketsSnap.docs[0]
  const marketData = marketDoc.data()

  await marketDoc.ref
    .collection('members')
    .doc(uid)
    .set({
      userId: uid,
      displayName: request.auth?.token.name || request.auth?.token.email || 'Anonymous',
      photoURL: request.auth?.token.picture || null,
      balance: marketData.defaultBalance,
      joinedAt: FieldValue.serverTimestamp(),
    })

  return { marketId: marketDoc.id }
})

export const createBet = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, question, type, outcomes, excludedMembers, closesAt, database } =
    request.data as {
      marketId: string
      question: string
      type: 'binary' | 'multiple_choice'
      outcomes: string[]
      excludedMembers: string[]
      closesAt: string
      database?: string
    }
  const db = getDb(database)

  // Validate inputs
  if (!marketId || !question?.trim()) {
    throw new HttpsError('invalid-argument', 'Market ID and question are required')
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

  // Verify user is a member of the market
  const memberDoc = await db
    .collection('markets')
    .doc(marketId)
    .collection('members')
    .doc(uid)
    .get()
  if (!memberDoc.exists) {
    throw new HttpsError('permission-denied', 'You are not a member of this market')
  }

  // Verify excluded members are actual members (if any)
  const sanitizedExcluded = (excludedMembers || []).filter(
    (id) => typeof id === 'string' && id.length > 0,
  )

  // Get market liquidity param
  const marketDoc = await db.collection('markets').doc(marketId).get()
  if (!marketDoc.exists) {
    throw new HttpsError('not-found', 'Market not found')
  }
  const liquidityParam = marketDoc.data()!.liquidityParam || 100

  const betRef = db.collection('markets').doc(marketId).collection('bets').doc()

  await betRef.set({
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
    totalVolume: 0,
  })

  return { betId: betRef.id }
})

export const executeTrade = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, betId, outcomeIndex, shares, database } = request.data as {
    marketId: string
    betId: string
    outcomeIndex: number
    shares: number
    database?: string
  }
  const db = getDb(database)

  if (!marketId || !betId) {
    throw new HttpsError('invalid-argument', 'Market ID and bet ID are required')
  }
  if (typeof outcomeIndex !== 'number' || typeof shares !== 'number' || shares === 0) {
    throw new HttpsError('invalid-argument', 'Valid outcome index and non-zero shares required')
  }
  if (!Number.isInteger(shares)) {
    throw new HttpsError('invalid-argument', 'Shares must be a whole number')
  }

  const marketRef = db.collection('markets').doc(marketId)
  const betRef = marketRef.collection('bets').doc(betId)
  const memberRef = marketRef.collection('members').doc(uid)
  const positionRef = betRef.collection('positions').doc(uid)

  const result = await db.runTransaction(async (txn) => {
    const [betSnap, memberSnap, positionSnap] = await Promise.all([
      txn.get(betRef),
      txn.get(memberRef),
      txn.get(positionRef),
    ])

    if (!betSnap.exists) {
      throw new HttpsError('not-found', 'Bet not found')
    }
    if (!memberSnap.exists) {
      throw new HttpsError('permission-denied', 'You are not a member of this market')
    }

    const bet = betSnap.data()!
    const member = memberSnap.data()!

    // Validate bet is open and not past close time
    if (bet.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Bet is not open for trading')
    }
    if (bet.closesAt.toDate().getTime() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'Bet has closed')
    }

    // Check user is not excluded
    if (bet.excludedMembers && bet.excludedMembers.includes(uid)) {
      throw new HttpsError('permission-denied', 'You are excluded from this bet')
    }

    // Validate outcome index
    if (outcomeIndex < 0 || outcomeIndex >= bet.outcomes.length) {
      throw new HttpsError('invalid-argument', 'Invalid outcome index')
    }

    const sharesSold: number[] = bet.sharesSold
    const totalVolume: number = bet.totalVolume ?? 0
    const bMax: number = bet.liquidityParam
    const b = calcEffectiveB(totalVolume, bMax)

    // Get current position
    const position = positionSnap.exists
      ? positionSnap.data()!
      : { shares: new Array(bet.outcomes.length).fill(0), totalCost: 0 }

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

    // For buys, enforce 100 shares per outcome cap
    if (shares > 0) {
      const currentShares = position.shares[outcomeIndex] ?? 0
      if (currentShares + shares > 100) {
        throw new HttpsError(
          'failed-precondition',
          `Exceeds 100-share limit. You have ${currentShares}, trying to buy ${shares}`,
        )
      }
    }

    // Calculate cost via LMSR
    const cost = calcCost(sharesSold, outcomeIndex, shares, b)

    // Update bet sharesSold and totalVolume
    const newSharesSold = [...sharesSold]
    newSharesSold[outcomeIndex] = (newSharesSold[outcomeIndex] ?? 0) + shares
    const newTotalVolume = totalVolume + Math.abs(shares)
    txn.update(betRef, { sharesSold: newSharesSold, totalVolume: newTotalVolume })

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

    // Record trade — compute priceAfter with the NEW effective b
    const bAfter = calcEffectiveB(newTotalVolume, bMax)
    const priceAfter = calcPrices(newSharesSold, bAfter)
    const tradeRef = betRef.collection('trades').doc()
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

export const resolveBet = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, betId, outcomeIndex, database } = request.data as {
    marketId: string
    betId: string
    outcomeIndex: number
    database?: string
  }
  const db = getDb(database)

  if (!marketId || !betId || typeof outcomeIndex !== 'number') {
    throw new HttpsError('invalid-argument', 'Market ID, bet ID, and outcome index are required')
  }

  const marketRef = db.collection('markets').doc(marketId)
  const betRef = marketRef.collection('bets').doc(betId)

  await db.runTransaction(async (txn) => {
    const betSnap = await txn.get(betRef)
    if (!betSnap.exists) {
      throw new HttpsError('not-found', 'Bet not found')
    }

    const bet = betSnap.data()!

    // Only the creator can resolve
    if (bet.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Only the bet creator can resolve this bet')
    }

    if (bet.status !== 'open' && bet.status !== 'closed') {
      throw new HttpsError('failed-precondition', 'Bet is already resolved or cancelled')
    }

    if (outcomeIndex < 0 || outcomeIndex >= bet.outcomes.length) {
      throw new HttpsError('invalid-argument', 'Invalid outcome index')
    }

    // All reads must happen before any writes in a Firestore transaction
    const positionsSnap = await txn.get(betRef.collection('positions'))

    // Read all member docs for winners
    const winnerUpdates: {
      memberRef: FirebaseFirestore.DocumentReference
      winningShares: number
      currentBalance: number
    }[] = []
    for (const posDoc of positionsSnap.docs) {
      const pos = posDoc.data()
      const winningShares: number = pos.shares[outcomeIndex] ?? 0
      if (winningShares > 0) {
        const memberRef = marketRef.collection('members').doc(posDoc.id)
        const memberSnap = await txn.get(memberRef)
        if (memberSnap.exists) {
          winnerUpdates.push({
            memberRef,
            winningShares,
            currentBalance: memberSnap.data()!.balance,
          })
        }
      }
    }

    // Now perform all writes
    txn.update(betRef, {
      status: 'resolved',
      resolvedOutcome: outcomeIndex,
    })

    for (const { memberRef, winningShares, currentBalance } of winnerUpdates) {
      txn.update(memberRef, { balance: currentBalance + winningShares })
    }
  })

  return { success: true }
})

export const cancelBet = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, betId, database } = request.data as {
    marketId: string
    betId: string
    database?: string
  }
  const db = getDb(database)

  if (!marketId || !betId) {
    throw new HttpsError('invalid-argument', 'Market ID and bet ID are required')
  }

  const marketRef = db.collection('markets').doc(marketId)
  const betRef = marketRef.collection('bets').doc(betId)

  await db.runTransaction(async (txn) => {
    const betSnap = await txn.get(betRef)
    if (!betSnap.exists) {
      throw new HttpsError('not-found', 'Bet not found')
    }

    const bet = betSnap.data()!

    // Only the creator can cancel
    if (bet.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Only the bet creator can cancel this bet')
    }

    if (bet.status === 'resolved' || bet.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'Bet is already resolved or cancelled')
    }

    // All reads must happen before any writes in a Firestore transaction
    const positionsSnap = await txn.get(betRef.collection('positions'))

    const refundUpdates: {
      memberRef: FirebaseFirestore.DocumentReference
      refundAmount: number
      currentBalance: number
    }[] = []
    for (const posDoc of positionsSnap.docs) {
      const pos = posDoc.data()
      const refundAmount: number = pos.totalCost
      if (refundAmount > 0) {
        const memberRef = marketRef.collection('members').doc(posDoc.id)
        const memberSnap = await txn.get(memberRef)
        if (memberSnap.exists) {
          refundUpdates.push({
            memberRef,
            refundAmount,
            currentBalance: memberSnap.data()!.balance,
          })
        }
      }
    }

    // Now perform all writes
    txn.update(betRef, {
      status: 'cancelled',
      resolvedOutcome: null,
    })

    for (const { memberRef, refundAmount, currentBalance } of refundUpdates) {
      txn.update(memberRef, { balance: currentBalance + refundAmount })
    }
  })

  return { success: true }
})
