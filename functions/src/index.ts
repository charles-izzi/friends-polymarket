import { setGlobalOptions } from 'firebase-functions'
import { onCall, HttpsError } from 'firebase-functions/https'
import { onSchedule } from 'firebase-functions/scheduler'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import * as crypto from 'crypto'
import { calcCost, calcPrices, calcEffectiveB, rescaleShares, calcSplitScore } from './lmsr'

// ---------- Commission ----------
// Creator earns a commission on resolution: each winner pays winningShares * rate * splitScore
// splitScore = normalized entropy of final prices (1 = max disagreement, 0 = consensus)
// Max per user = 100 shares * 0.02 * 1.0 = $2.00 (naturally bounded, no cap needed)
const CREATOR_COMMISSION_RATE = 0.02

// ---------- Stats types (mirrored from src/types.ts) ----------
interface ResolvedBetRecord {
  betId: string
  question: string
  resolvedAt: FirebaseFirestore.Timestamp
  totalCost: number
  payout: number
  profit: number
  entryProbability: number
  primaryOutcome: number
  winningOutcome: number
  wasFavorite: boolean
}

interface UserStats {
  resolvedBets: ResolvedBetRecord[]
  totalResolved: number
  wins: number
  totalWagered: number
  totalProfit: number
  currentStreak: { type: 'win' | 'loss'; count: number }
  bestBet: { betId: string; question: string; profit: number } | null
  worstBet: { betId: string; question: string; profit: number } | null
  biggestUpset: {
    betId: string
    question: string
    entryProbability: number
    profit: number
  } | null
  avgBetSize: number
  favoriteRate: number
}

function recomputeStats(records: ResolvedBetRecord[]): Omit<UserStats, 'resolvedBets'> {
  let wins = 0
  let totalWagered = 0
  let totalProfit = 0
  let favoriteCount = 0
  let bestBet: UserStats['bestBet'] = null
  let worstBet: UserStats['worstBet'] = null
  let biggestUpset: UserStats['biggestUpset'] = null
  const currentStreak: UserStats['currentStreak'] = { type: 'win', count: 0 }

  for (const r of records) {
    const isWin = r.profit > 0
    if (isWin) wins++
    totalWagered += Math.abs(r.totalCost)
    totalProfit += r.profit
    if (r.wasFavorite) favoriteCount++

    if (!bestBet || r.profit > bestBet.profit) {
      bestBet = { betId: r.betId, question: r.question, profit: r.profit }
    }
    if (!worstBet || r.profit < worstBet.profit) {
      worstBet = { betId: r.betId, question: r.question, profit: r.profit }
    }
    if (isWin && (!biggestUpset || r.entryProbability < biggestUpset.entryProbability)) {
      biggestUpset = {
        betId: r.betId,
        question: r.question,
        entryProbability: r.entryProbability,
        profit: r.profit,
      }
    }
  }

  // Streak: walk from most recent backwards
  if (records.length > 0) {
    const lastWin = records[records.length - 1]!.profit > 0
    currentStreak.type = lastWin ? 'win' : 'loss'
    currentStreak.count = 0
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]!.profit > 0 === lastWin) {
        currentStreak.count++
      } else break
    }
  }

  const totalResolved = records.length
  return {
    totalResolved,
    wins,
    totalWagered,
    totalProfit,
    currentStreak,
    bestBet,
    worstBet,
    biggestUpset,
    avgBetSize: totalResolved > 0 ? totalWagered / totalResolved : 0,
    favoriteRate: totalResolved > 0 ? favoriteCount / totalResolved : 0,
  }
}

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

function formatDuration(diffMs: number): string {
  if (diffMs <= 0) return ''
  const days = Math.floor(diffMs / 86400000)
  const hours = Math.floor((diffMs % 86400000) / 3600000)
  const minutes = Math.floor((diffMs % 3600000) / 60000)
  if (days > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${minutes}m left`
  return `${minutes}m left`
}

/**
 * Send push notifications to a list of users. Fire-and-forget — errors are logged, not thrown.
 */
async function sendPushToUsers(
  db: FirebaseFirestore.Firestore,
  marketId: string,
  userIds: string[],
  notification: { title: string; body: string },
  data: Record<string, string>,
) {
  if (userIds.length === 0) return

  const messaging = getMessaging()

  // Collect all FCM tokens for target users from top-level users collection
  const tokenDocs: { ref: FirebaseFirestore.DocumentReference; token: string }[] = []
  for (const userId of userIds) {
    const tokensSnap = await db.collection('users').doc(userId).collection('fcmTokens').get()
    for (const doc of tokensSnap.docs) {
      const token = doc.data().token
      if (typeof token === 'string' && token.length > 0) {
        tokenDocs.push({ ref: doc.ref, token })
      }
    }
  }

  // Send with both top-level notification (for FCM) and explicit webpush.notification
  // (for the browser's Web Notifications API). The webpush.notification block is what
  // the browser actually uses to render the notification on mobile.
  const results = await Promise.allSettled(
    tokenDocs.map(({ ref, token }) =>
      messaging
        .send({
          token,
          notification,
          data: { ...data, title: notification.title, body: notification.body },
          webpush: {
            headers: { Urgency: 'high' },
            notification: {
              title: notification.title,
              body: notification.body,
              icon: '/logo-192.png',
            },
            fcmOptions: {
              link: data.betId && data.marketId ? `/${data.marketId}/bets/${data.betId}` : '/',
            },
          },
        })
        .catch(async (err: { code?: string }) => {
          // Clean up stale tokens
          if (
            err.code === 'messaging/registration-token-not-registered' ||
            err.code === 'messaging/invalid-registration-token'
          ) {
            await ref.delete().catch(() => {})
          }
          throw err
        }),
    ),
  )

  const failures = results.filter((r) => r.status === 'rejected').length
  if (failures > 0) {
    console.warn(`Push: ${failures}/${tokenDocs.length} sends failed for market ${marketId}`)
  }
  console.log(
    `Push: sent to ${tokenDocs.length - failures}/${tokenDocs.length} tokens for ${userIds.length} users in market ${marketId}`,
  )
}

export const registerFcmToken = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { token, database } = request.data as { token: string; database?: string }
  const db = getDb(database)

  if (!token || typeof token !== 'string') {
    throw new HttpsError('invalid-argument', 'FCM token is required')
  }

  const tokensRef = db.collection('users').doc(uid).collection('fcmTokens')

  // Check if token already exists to avoid duplicates
  const existing = await tokensRef.where('token', '==', token).limit(1).get()
  if (!existing.empty) {
    return { success: true }
  }

  await tokensRef.add({
    token,
    createdAt: FieldValue.serverTimestamp(),
  })

  return { success: true }
})

export const createMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { name, database } = request.data as { name: string; database?: string }
  const db = getDb(database)
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Market name is required')
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

  // Check user isn't already a member of this specific market
  const marketsSnap_check = await db
    .collection('markets')
    .where('inviteCode', '==', inviteCode.trim())
    .limit(1)
    .get()
  if (!marketsSnap_check.empty) {
    const targetMarketId = marketsSnap_check.docs[0]!.id
    const alreadyMember = await db
      .collection('markets')
      .doc(targetMarketId)
      .collection('members')
      .doc(uid)
      .get()
    if (alreadyMember.exists) {
      return { marketId: targetMarketId }
    }
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

export const leaveMarket = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, database } = request.data as { marketId: string; database?: string }
  const db = getDb(database)
  if (!marketId || typeof marketId !== 'string') {
    throw new HttpsError('invalid-argument', 'Market ID is required')
  }

  const marketRef = db.collection('markets').doc(marketId)
  const marketDoc = await marketRef.get()
  if (!marketDoc.exists) {
    throw new HttpsError('not-found', 'Market not found')
  }

  // Prevent owner from leaving
  if (marketDoc.data()!.ownerId === uid) {
    throw new HttpsError(
      'failed-precondition',
      'Market owner cannot leave. Delete the market instead.',
    )
  }

  const memberRef = marketRef.collection('members').doc(uid)
  const memberDoc = await memberRef.get()
  if (!memberDoc.exists) {
    throw new HttpsError('not-found', 'You are not a member of this market')
  }

  await memberRef.delete()
  return { success: true }
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
    lastTradeAt: null,
    commissionEnabled: true,
  })

  // Send push notifications to all market members except creator and excluded
  const membersSnap = await db.collection('markets').doc(marketId).collection('members').get()
  const creatorName = memberDoc.data()!.displayName || 'Someone'
  const targetUserIds = membersSnap.docs
    .map((d) => d.id)
    .filter((id) => id !== uid && !sanitizedExcluded.includes(id))
  const timeLeft = formatDuration(closeDate.getTime() - Date.now())
  sendPushToUsers(
    db,
    marketId,
    targetUserIds,
    {
      title: `${creatorName} created a bet`,
      body: `${question.trim()}${timeLeft ? ` · ${timeLeft}` : ''}`,
    },
    { betId: betRef.id, type: 'bet_created', marketId },
  ).catch(() => {})

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

    // Creator cannot be the first to wager on their own bet
    if (uid === bet.createdBy && (bet.totalVolume ?? 0) === 0) {
      throw new HttpsError(
        'failed-precondition',
        'You must wait for someone else to place the first wager',
      )
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
    const bBefore = calcEffectiveB(totalVolume, bMax)

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

    // Calculate cost via LMSR at the current b
    const cost = calcCost(sharesSold, outcomeIndex, shares, bBefore)

    // Compute post-trade sharesSold, then rescale to preserve prices under the new b
    const postTradeShares = [...sharesSold]
    postTradeShares[outcomeIndex] = (postTradeShares[outcomeIndex] ?? 0) + shares
    const newTotalVolume = totalVolume + Math.abs(shares)
    const bAfter = calcEffectiveB(newTotalVolume, bMax)
    const newSharesSold = rescaleShares(postTradeShares, bBefore, bAfter)
    txn.update(betRef, {
      sharesSold: newSharesSold,
      totalVolume: newTotalVolume,
      lastTradeAt: FieldValue.serverTimestamp(),
    })

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

    // Record trade — priceAfter uses the rescaled shares with bAfter
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
      _isFirstTrade: totalVolume === 0,
      _createdBy: bet.createdBy as string,
      _question: bet.question as string,
    }
  })

  // Notify bet creator when the first wager is placed on their bet
  if (result._isFirstTrade && result._createdBy !== uid) {
    sendPushToUsers(
      db,
      marketId,
      [result._createdBy],
      {
        title: 'First wager placed!',
        body: `You can now make trades on your bet — someone bet on "${result._question}"`,
      },
      { betId, type: 'first_wager', marketId },
    ).catch(() => {})
  }

  return {
    tradeId: result.tradeId,
    cost: result.cost,
    newBalance: result.newBalance,
    priceAfter: result.priceAfter,
  }
})

export const resolveBet = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, betId, outcomeIndex, resolvesAt, database } = request.data as {
    marketId: string
    betId: string
    outcomeIndex: number
    resolvesAt?: string
    database?: string
  }
  const db = getDb(database)

  if (!marketId || !betId || typeof outcomeIndex !== 'number') {
    throw new HttpsError('invalid-argument', 'Market ID, bet ID, and outcome index are required')
  }

  // Validate optional resolvesAt
  let resolveDate: Date | null = null
  if (resolvesAt) {
    resolveDate = new Date(resolvesAt)
    if (isNaN(resolveDate.getTime())) {
      throw new HttpsError('invalid-argument', 'Invalid resolution time')
    }
  }

  const marketRef = db.collection('markets').doc(marketId)
  const betRef = marketRef.collection('bets').doc(betId)

  const pushData = await db.runTransaction(async (txn) => {
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

    // Read all trades for this bet to determine entry probabilities (for stats)
    const tradesSnap = await txn.get(betRef.collection('trades').orderBy('createdAt', 'asc'))
    const allTrades = tradesSnap.docs.map((d) => d.data())

    // If resolvesAt is set, compute per-user invalidated trade amounts
    const resolveCutoff = resolveDate ? Timestamp.fromDate(resolveDate) : null
    const invalidatedCostPerUser = new Map<string, number>()
    const invalidatedSharesPerUser = new Map<string, number[]>()

    // Round cutoff UP to the end of its minute so trades within the same minute are valid
    const resolveCutoffMinute = resolveCutoff
      ? Math.floor(resolveCutoff.toMillis() / 60000) * 60000 + 59999
      : null

    if (resolveCutoffMinute !== null) {
      for (const t of allTrades) {
        if (t.createdAt && t.createdAt.toMillis() > resolveCutoffMinute) {
          const userId: string = t.userId
          invalidatedCostPerUser.set(
            userId,
            (invalidatedCostPerUser.get(userId) ?? 0) + (t.cost as number),
          )
          if (!invalidatedSharesPerUser.has(userId)) {
            invalidatedSharesPerUser.set(userId, new Array(bet.outcomes.length).fill(0))
          }
          const shares = invalidatedSharesPerUser.get(userId)!
          shares[t.outcomeIndex as number] =
            (shares[t.outcomeIndex as number] ?? 0) + (t.shares as number)
        }
      }
    }

    // Pre-compute entry info per user: first trade's priceAfter gives entry probabilities
    const userFirstTrade = new Map<string, { priceAfter: number[] }>()
    for (const t of allTrades) {
      if (!userFirstTrade.has(t.userId)) {
        userFirstTrade.set(t.userId, { priceAfter: t.priceAfter })
      }
    }

    // Read all member docs for winners + all staked members for stats
    const winnerUpdates: {
      memberRef: FirebaseFirestore.DocumentReference
      balanceCredit: number
      currentBalance: number
    }[] = []
    const stakedUsers: { userId: string; totalCost: number; payout: number; refund: number }[] = []
    const memberBalances = new Map<string, number>()

    // Compute effective (valid) positions per user
    for (const posDoc of positionsSnap.docs) {
      const pos = posDoc.data()
      const rawShares: number[] = pos.shares
      const rawCost: number = pos.totalCost

      // Subtract invalidated trades to get valid position
      const invShares = invalidatedSharesPerUser.get(posDoc.id)
      const invCost = invalidatedCostPerUser.get(posDoc.id) ?? 0
      const validShares = invShares ? rawShares.map((s, i) => s - (invShares[i] ?? 0)) : rawShares
      const validCost = rawCost - invCost

      const totalValidShares = validShares.reduce((s, v) => s + v, 0)
      if (totalValidShares > 0 || validCost > 0 || invCost > 0) {
        const payout = validShares[outcomeIndex] ?? 0
        stakedUsers.push({ userId: posDoc.id, totalCost: validCost, payout, refund: invCost })
      }

      const validWinningShares = validShares[outcomeIndex] ?? 0
      // Read member doc for all users who have any position (needed for balance + stats + refund)
      if (
        validWinningShares > 0 ||
        validShares.reduce((s: number, v: number) => s + v, 0) > 0 ||
        validCost > 0 ||
        invCost > 0
      ) {
        const memberRef = marketRef.collection('members').doc(posDoc.id)
        const memberSnap = await txn.get(memberRef)
        if (memberSnap.exists) {
          const bal = memberSnap.data()!.balance as number
          memberBalances.set(posDoc.id, bal)
          // Credit = valid winning shares + refund for invalidated trades
          const balanceCredit = validWinningShares + invCost
          if (balanceCredit > 0) {
            winnerUpdates.push({ memberRef, balanceCredit, currentBalance: bal })
          }
        }
      }
    }

    // Read existing stats docs for all staked users
    const existingStats = new Map<string, UserStats | null>()
    for (const user of stakedUsers) {
      const statsRef = marketRef.collection('stats').doc(user.userId)
      const statsSnap = await txn.get(statsRef)
      existingStats.set(user.userId, statsSnap.exists ? (statsSnap.data() as UserStats) : null)
    }
    // Also read creator's stats if they're not already in stakedUsers (for commission P/L)
    const creatorId = bet.createdBy as string
    if (!existingStats.has(creatorId)) {
      const creatorStatsRef = marketRef.collection('stats').doc(creatorId)
      const creatorStatsSnap = await txn.get(creatorStatsRef)
      existingStats.set(
        creatorId,
        creatorStatsSnap.exists ? (creatorStatsSnap.data() as UserStats) : null,
      )
    }

    // ---- All reads complete — now perform writes ----

    // Calculate creator commission based on how divided the group was
    // Each winner pays: winningShares × rate × splitScore
    // Only applies to bets created with commission enabled
    const commissionEnabled = bet.commissionEnabled === true
    const sharesSold: number[] = bet.sharesSold
    const bMax: number = bet.liquidityParam
    const totalVolume: number = bet.totalVolume ?? 0
    const bEff = calcEffectiveB(totalVolume, bMax)
    const finalPrices = calcPrices(sharesSold, bEff)
    const splitScore = commissionEnabled ? calcSplitScore(finalPrices) : 0
    const feeRate = CREATOR_COMMISSION_RATE * splitScore

    // Per-user fee: winningShares × rate × splitScore
    const userFeeMap = new Map<string, number>()
    let commission = 0
    for (const user of stakedUsers) {
      if (user.payout > 0) {
        const fee = user.payout * feeRate
        userFeeMap.set(user.userId, fee)
        commission += fee
      }
    }

    // Adjust winner payouts: deduct each user's fee
    for (const wu of winnerUpdates) {
      const userId = wu.memberRef.id
      const fee = userFeeMap.get(userId) ?? 0
      wu.balanceCredit = wu.balanceCredit - fee
    }

    // Also adjust stakedUsers payout for accurate stats/notifications
    for (const user of stakedUsers) {
      if (user.payout > 0) {
        const fee = userFeeMap.get(user.userId) ?? 0
        user.payout = user.payout - fee
      }
    }

    // Store feeRate for client display (rate × splitScore, client multiplies by their shares)
    const commissionPerShare = feeRate

    txn.update(betRef, {
      status: 'resolved',
      resolvedOutcome: outcomeIndex,
      creatorCommission: commission,
      commissionPerShare,
      splitScore,
      ...(resolveDate ? { resolvesAt: Timestamp.fromDate(resolveDate) } : {}),
    })

    let creatorCredited = false

    for (const { memberRef, balanceCredit, currentBalance } of winnerUpdates) {
      const isCreator = memberRef.id === creatorId
      const extra = isCreator && commission > 0 ? commission : 0
      if (isCreator) creatorCredited = true
      txn.update(memberRef, { balance: currentBalance + balanceCredit + extra })
    }

    // Credit the creator's balance with the commission if not already handled
    if (commission > 0 && !creatorCredited) {
      const creatorMemberRef = marketRef.collection('members').doc(creatorId)
      if (memberBalances.has(creatorId)) {
        // Creator has a position (was read) but isn't a winner
        txn.update(creatorMemberRef, { balance: memberBalances.get(creatorId)! + commission })
      } else {
        // Creator has no position — use atomic increment
        txn.update(creatorMemberRef, { balance: FieldValue.increment(commission) })
      }
    }

    // Write stats for each staked user (based on valid positions only)
    for (const user of stakedUsers) {
      const posDoc = positionsSnap.docs.find((d) => d.id === user.userId)
      const rawShares: number[] = posDoc ? posDoc.data().shares : []
      const invShares = invalidatedSharesPerUser.get(user.userId)
      const shares = invShares ? rawShares.map((s, i) => s - (invShares[i] ?? 0)) : rawShares
      const primaryOutcome = shares.reduce((best, s, i) => (s > (shares[best] ?? 0) ? i : best), 0)

      const firstTrade = userFirstTrade.get(user.userId)
      const entryPrices = firstTrade?.priceAfter ?? []
      const entryProbability = entryPrices[primaryOutcome] ?? 1 / (bet.outcomes.length || 2)

      let wasFavorite = false
      if (entryPrices.length > 0) {
        const maxPrice = Math.max(...entryPrices)
        wasFavorite = (entryPrices[primaryOutcome] ?? 0) >= maxPrice - 0.001
      }

      // Include commission in creator's profit
      const isCreatorUser = user.userId === creatorId
      const commissionForProfit = isCreatorUser ? commission : 0

      const record: ResolvedBetRecord = {
        betId,
        question: bet.question,
        resolvedAt: Timestamp.now(),
        totalCost: user.totalCost,
        payout: user.payout + commissionForProfit,
        profit: user.payout + commissionForProfit - user.totalCost,
        entryProbability,
        primaryOutcome,
        winningOutcome: outcomeIndex,
        wasFavorite,
      }

      const existing = existingStats.get(user.userId)
      const allRecords = [...(existing?.resolvedBets ?? []), record]
      const statsComputed = recomputeStats(allRecords)
      txn.set(marketRef.collection('stats').doc(user.userId), {
        resolvedBets: allRecords,
        ...statsComputed,
      })
    }

    // If creator has no position but earned commission, write a stats record for them
    if (commission > 0 && !stakedUsers.some((u) => u.userId === creatorId)) {
      const record: ResolvedBetRecord = {
        betId,
        question: bet.question,
        resolvedAt: Timestamp.now(),
        totalCost: 0,
        payout: commission,
        profit: commission,
        entryProbability: 0,
        primaryOutcome: 0,
        winningOutcome: outcomeIndex,
        wasFavorite: false,
      }

      const existing = existingStats.get(creatorId)
      const allRecords = [...(existing?.resolvedBets ?? []), record]
      const statsComputed = recomputeStats(allRecords)
      txn.set(marketRef.collection('stats').doc(creatorId), {
        resolvedBets: allRecords,
        ...statsComputed,
      })
    }

    return {
      question: bet.question as string,
      winningOutcome: bet.outcomes[outcomeIndex] as string,
      stakedUsers,
      commission,
      creatorId: bet.createdBy as string,
    }
  })

  // Send push notifications to all staked users (except the resolver)
  for (const user of pushData.stakedUsers) {
    if (user.userId === uid) continue
    const profit = user.payout - user.totalCost
    const profitStr = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`
    const refundStr = user.refund > 0 ? ` · Refund: $${user.refund.toFixed(2)}` : ''
    sendPushToUsers(
      db,
      marketId,
      [user.userId],
      {
        title: `Resolved: "${pushData.winningOutcome}" won!`,
        body: `Cost: $${user.totalCost.toFixed(2)} · Payout: $${user.payout.toFixed(2)} · Profit: ${profitStr}${refundStr}`,
      },
      { betId, type: 'bet_resolved', marketId },
    ).catch(() => {})
  }

  // Notify the creator about their commission earned
  if (pushData.commission > 0) {
    sendPushToUsers(
      db,
      marketId,
      [pushData.creatorId],
      {
        title: `Commission earned!`,
        body: `You earned $${pushData.commission.toFixed(2)} for creating "${pushData.question}"`,
      },
      { betId, type: 'bet_resolved', marketId },
    ).catch(() => {})
  }

  return { success: true }
})

// ---------- Unresolve helpers ----------

/**
 * Shared unresolve logic used by both direct unresolve (creator) and contest-triggered unresolve.
 * Must be called within a Firestore transaction with all reads already done.
 */
function performUnresolve(
  txn: FirebaseFirestore.Transaction,
  betRef: FirebaseFirestore.DocumentReference,
  bet: FirebaseFirestore.DocumentData,
  marketRef: FirebaseFirestore.DocumentReference,
  positionsSnap: FirebaseFirestore.QuerySnapshot,
  allTrades: FirebaseFirestore.DocumentData[],
  existingStats: Map<string, UserStats | null>,
  memberBalances: Map<string, number>,
): { stakedUserIds: string[] } {
  const outcomeIndex: number = bet.resolvedOutcome
  const creatorId: string = bet.createdBy
  const commissionEnabled = bet.commissionEnabled === true

  // Recompute what each user was credited at resolution time
  const resolveCutoff = bet.resolvesAt ?? null
  const resolveCutoffMinute = resolveCutoff
    ? Math.floor(resolveCutoff.toMillis() / 60000) * 60000 + 59999
    : null

  const invalidatedCostPerUser = new Map<string, number>()
  const invalidatedSharesPerUser = new Map<string, number[]>()

  if (resolveCutoffMinute !== null) {
    for (const t of allTrades) {
      if (t.createdAt && t.createdAt.toMillis() > resolveCutoffMinute) {
        const userId: string = t.userId
        invalidatedCostPerUser.set(
          userId,
          (invalidatedCostPerUser.get(userId) ?? 0) + (t.cost as number),
        )
        if (!invalidatedSharesPerUser.has(userId)) {
          invalidatedSharesPerUser.set(userId, new Array(bet.outcomes.length).fill(0))
        }
        const shares = invalidatedSharesPerUser.get(userId)!
        shares[t.outcomeIndex as number] =
          (shares[t.outcomeIndex as number] ?? 0) + (t.shares as number)
      }
    }
  }

  // Calculate the fee rate that was applied at resolution
  const sharesSold: number[] = bet.sharesSold
  const bMax: number = bet.liquidityParam
  const totalVolume: number = bet.totalVolume ?? 0
  const bEff = calcEffectiveB(totalVolume, bMax)
  const finalPrices = calcPrices(sharesSold, bEff)
  const splitScore = commissionEnabled ? calcSplitScore(finalPrices) : 0
  const feeRate = CREATOR_COMMISSION_RATE * splitScore

  // Determine what each user was credited and subtract it
  const stakedUserIds: string[] = []
  let totalCommission = 0

  for (const posDoc of positionsSnap.docs) {
    const pos = posDoc.data()
    const rawShares: number[] = pos.shares
    const invShares = invalidatedSharesPerUser.get(posDoc.id)
    const invCost = invalidatedCostPerUser.get(posDoc.id) ?? 0
    const validShares = invShares ? rawShares.map((s, i) => s - (invShares[i] ?? 0)) : rawShares
    const validWinningShares = validShares[outcomeIndex] ?? 0

    const totalValidShares = validShares.reduce((s, v) => s + v, 0)
    if (totalValidShares <= 0 && pos.totalCost <= 0 && invCost <= 0) continue

    stakedUserIds.push(posDoc.id)

    // What was credited: validWinningShares - fee + refund
    const fee = validWinningShares > 0 ? validWinningShares * feeRate : 0
    totalCommission += fee
    const credit = validWinningShares - fee + invCost

    if (credit > 0) {
      const currentBalance = memberBalances.get(posDoc.id) ?? 0
      const memberRef = marketRef.collection('members').doc(posDoc.id)
      txn.update(memberRef, { balance: currentBalance - credit })
    }

    // Remove this bet's record from user stats
    const userStats = existingStats.get(posDoc.id)
    if (userStats) {
      const filteredRecords = userStats.resolvedBets.filter((r) => r.betId !== betRef.id)
      if (filteredRecords.length > 0) {
        const statsComputed = recomputeStats(filteredRecords)
        txn.set(marketRef.collection('stats').doc(posDoc.id), {
          resolvedBets: filteredRecords,
          ...statsComputed,
        })
      } else {
        txn.delete(marketRef.collection('stats').doc(posDoc.id))
      }
    }
  }

  // Reverse creator commission
  if (totalCommission > 0) {
    const creatorBalance = memberBalances.get(creatorId) ?? 0
    const creatorMemberRef = marketRef.collection('members').doc(creatorId)
    // If creator was also a staked user, their balance was already adjusted above;
    // but we need to also subtract the commission they received
    if (stakedUserIds.includes(creatorId)) {
      // Already subtracted their winning credit above; now also subtract commission
      txn.update(creatorMemberRef, { balance: FieldValue.increment(-totalCommission) })
    } else {
      // Creator only received commission (no position)
      txn.update(creatorMemberRef, { balance: creatorBalance - totalCommission })
    }

    // Remove creator's commission-only stats record if they weren't staked
    if (!stakedUserIds.includes(creatorId)) {
      const creatorStats = existingStats.get(creatorId)
      if (creatorStats) {
        const filteredRecords = creatorStats.resolvedBets.filter((r) => r.betId !== betRef.id)
        if (filteredRecords.length > 0) {
          const statsComputed = recomputeStats(filteredRecords)
          txn.set(marketRef.collection('stats').doc(creatorId), {
            resolvedBets: filteredRecords,
            ...statsComputed,
          })
        } else {
          txn.delete(marketRef.collection('stats').doc(creatorId))
        }
      }
    }
  }

  // Reset bet status: open if closesAt is in the future, else closed
  const closesAt = bet.closesAt as FirebaseFirestore.Timestamp
  const newStatus = closesAt.toMillis() > Date.now() ? 'open' : 'closed'

  txn.update(betRef, {
    status: newStatus,
    resolvedOutcome: FieldValue.delete(),
    creatorCommission: FieldValue.delete(),
    commissionPerShare: FieldValue.delete(),
    splitScore: FieldValue.delete(),
    resolvesAt: FieldValue.delete(),
    contests: FieldValue.delete(),
  })

  return { stakedUserIds }
}

export const unresolveBet = onCall(async (request) => {
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

  const pushData = await db.runTransaction(async (txn) => {
    const betSnap = await txn.get(betRef)
    if (!betSnap.exists) throw new HttpsError('not-found', 'Bet not found')

    const bet = betSnap.data()!

    if (bet.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Only the bet creator can unresolve this bet')
    }

    if (bet.status !== 'resolved') {
      throw new HttpsError('failed-precondition', 'Bet is not resolved')
    }

    // All reads
    const positionsSnap = await txn.get(betRef.collection('positions'))
    const tradesSnap = await txn.get(betRef.collection('trades').orderBy('createdAt', 'asc'))
    const allTrades = tradesSnap.docs.map((d) => d.data())

    const memberBalances = new Map<string, number>()
    const existingStats = new Map<string, UserStats | null>()
    const allUserIds = new Set<string>()

    for (const posDoc of positionsSnap.docs) allUserIds.add(posDoc.id)
    allUserIds.add(bet.createdBy)

    for (const userId of allUserIds) {
      const memberSnap = await txn.get(marketRef.collection('members').doc(userId))
      if (memberSnap.exists) memberBalances.set(userId, memberSnap.data()!.balance)
      const statsSnap = await txn.get(marketRef.collection('stats').doc(userId))
      existingStats.set(userId, statsSnap.exists ? (statsSnap.data() as UserStats) : null)
    }

    const { stakedUserIds } = performUnresolve(
      txn,
      betRef,
      bet,
      marketRef,
      positionsSnap,
      allTrades,
      existingStats,
      memberBalances,
    )

    return { question: bet.question as string, stakedUserIds }
  })

  // Notify all staked users that the bet was unresolved
  const targetIds = pushData.stakedUserIds.filter((id) => id !== uid)
  if (targetIds.length > 0) {
    sendPushToUsers(
      db,
      marketId,
      targetIds,
      {
        title: 'Bet unresolved',
        body: `"${pushData.question}" has been reopened by its creator`,
      },
      { betId, type: 'bet_unresolved', marketId },
    ).catch(() => {})
  }

  return { success: true }
})

export const contestBet = onCall(async (request) => {
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

  const pushData = await db.runTransaction(async (txn) => {
    const betSnap = await txn.get(betRef)
    if (!betSnap.exists) throw new HttpsError('not-found', 'Bet not found')

    const bet = betSnap.data()!

    if (bet.status !== 'resolved') {
      throw new HttpsError('failed-precondition', 'Bet is not resolved')
    }

    if (bet.createdBy === uid) {
      throw new HttpsError('permission-denied', 'The bet creator cannot contest their own bet')
    }

    // Verify user is a market member
    const memberSnap = await txn.get(marketRef.collection('members').doc(uid))
    if (!memberSnap.exists) {
      throw new HttpsError('permission-denied', 'Must be a market member')
    }

    const contests: string[] = bet.contests ?? []
    if (contests.includes(uid)) {
      throw new HttpsError('already-exists', 'You have already contested this bet')
    }

    const contestorName = memberSnap.data()!.displayName || 'Someone'
    const newContests = [...contests, uid]

    // If threshold reached (2 contests), unresolve
    if (newContests.length >= 2) {
      // Need all reads for unresolve
      const positionsSnap = await txn.get(betRef.collection('positions'))
      const tradesSnap = await txn.get(betRef.collection('trades').orderBy('createdAt', 'asc'))
      const allTrades = tradesSnap.docs.map((d) => d.data())

      const memberBalances = new Map<string, number>()
      const existingStats = new Map<string, UserStats | null>()
      const allUserIds = new Set<string>()

      for (const posDoc of positionsSnap.docs) allUserIds.add(posDoc.id)
      allUserIds.add(bet.createdBy)

      for (const userId of allUserIds) {
        const mSnap = await txn.get(marketRef.collection('members').doc(userId))
        if (mSnap.exists) memberBalances.set(userId, mSnap.data()!.balance)
        const sSnap = await txn.get(marketRef.collection('stats').doc(userId))
        existingStats.set(userId, sSnap.exists ? (sSnap.data() as UserStats) : null)
      }

      performUnresolve(
        txn,
        betRef,
        bet,
        marketRef,
        positionsSnap,
        allTrades,
        existingStats,
        memberBalances,
      )

      const stakedUserIds = positionsSnap.docs.map((d) => d.id)
      return {
        overturned: true,
        question: bet.question as string,
        creatorId: bet.createdBy as string,
        contestorName,
        stakedUserIds,
      }
    } else {
      // First contest — just record it
      txn.update(betRef, { contests: newContests })

      // Read positions to determine staked users for notifications
      const positionsSnap = await txn.get(betRef.collection('positions'))
      const stakedUserIds = positionsSnap.docs.map((d) => d.id)
      return {
        overturned: false,
        question: bet.question as string,
        creatorId: bet.createdBy as string,
        contestorName,
        stakedUserIds,
      }
    }
  })

  if (pushData.overturned) {
    // Notify staked users (except the contestor) that the bet was overturned
    const targetIds = pushData.stakedUserIds.filter((id: string) => id !== uid)
    if (targetIds.length > 0) {
      sendPushToUsers(
        db,
        marketId,
        targetIds,
        {
          title: 'Bet overturned',
          body: `"${pushData.question}" has been unresolved after 2 contests`,
        },
        { betId, type: 'bet_overturned', marketId },
      ).catch(() => {})
    }
  } else {
    // Notify staked users (except the contestor) about the contest
    const targetIds = pushData.stakedUserIds.filter((id: string) => id !== uid)
    if (targetIds.length > 0) {
      sendPushToUsers(
        db,
        marketId,
        targetIds,
        {
          title: 'Resolution contested',
          body: `${pushData.contestorName} contested "${pushData.question}"`,
        },
        { betId, type: 'bet_contested', marketId },
      ).catch(() => {})
    }
  }

  return { success: true, overturned: pushData.overturned }
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

  const cancelData = await db.runTransaction(async (txn) => {
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
    const refundedUsers: { userId: string; refundAmount: number }[] = []

    for (const posDoc of positionsSnap.docs) {
      const pos = posDoc.data()
      const refundAmount: number = pos.totalCost
      if (refundAmount > 0) {
        refundedUsers.push({ userId: posDoc.id, refundAmount })
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

    return { question: bet.question as string, refundedUsers }
  })

  // Send push notifications to refunded users (except the canceller)
  for (const user of cancelData.refundedUsers) {
    if (user.userId === uid) continue
    sendPushToUsers(
      db,
      marketId,
      [user.userId],
      {
        title: 'Bet cancelled',
        body: `"${cancelData.question}" · Refunded: $${user.refundAmount.toFixed(2)}`,
      },
      { betId, type: 'bet_cancelled', marketId },
    ).catch(() => {})
  }

  return { success: true }
})

export const editBet = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, betId, question, outcomes, excludedMembers, closesAt, database } =
    request.data as {
      marketId: string
      betId: string
      question?: string
      outcomes?: string[]
      excludedMembers?: string[]
      closesAt?: string
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

    if (bet.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Only the bet creator can edit this bet')
    }

    if (bet.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Only open bets can be edited')
    }

    const updates: Record<string, unknown> = {}

    // Check if anyone has traded on this bet
    const tradesSnap = await txn.get(betRef.collection('trades').limit(1))
    const hasTrades = !tradesSnap.empty

    // Question: only editable if no trades
    if (question !== undefined) {
      if (hasTrades) {
        throw new HttpsError(
          'failed-precondition',
          'Cannot edit question after trades have been placed',
        )
      }
      if (!question.trim()) {
        throw new HttpsError('invalid-argument', 'Question cannot be empty')
      }
      updates.question = question.trim()
    }

    // Outcomes: only editable if no trades
    if (outcomes !== undefined) {
      if (hasTrades) {
        throw new HttpsError(
          'failed-precondition',
          'Cannot edit outcomes after trades have been placed',
        )
      }
      if (!Array.isArray(outcomes) || outcomes.filter((o) => o.trim()).length < 2) {
        throw new HttpsError('invalid-argument', 'At least 2 non-empty outcomes are required')
      }
      if (outcomes.length > 10) {
        throw new HttpsError('invalid-argument', 'Maximum 10 outcomes allowed')
      }
      const trimmed = outcomes.filter((o) => o.trim()).map((o) => o.trim())
      updates.outcomes = trimmed
      updates.sharesSold = new Array(trimmed.length).fill(0)
    }

    // Excluded members: can only add, not remove; new members must not have traded
    if (excludedMembers !== undefined) {
      const currentExcluded: string[] = bet.excludedMembers || []
      const newExcluded = excludedMembers.filter(
        (id: string) => typeof id === 'string' && id.length > 0,
      )

      // Check no existing excluded members are being removed
      for (const id of currentExcluded) {
        if (!newExcluded.includes(id)) {
          throw new HttpsError('failed-precondition', 'Cannot remove previously excluded members')
        }
      }

      // Check newly added excluded members haven't already traded
      const newlyAdded = newExcluded.filter((id: string) => !currentExcluded.includes(id))
      if (newlyAdded.length > 0) {
        const positionsSnap = await txn.get(betRef.collection('positions'))
        const tradedUserIds = new Set(
          positionsSnap.docs
            .filter((d) => {
              const pos = d.data()
              return pos.totalCost > 0 || (pos.shares as number[]).some((s: number) => s > 0)
            })
            .map((d) => d.id),
        )
        for (const id of newlyAdded) {
          if (tradedUserIds.has(id)) {
            const memberDoc = await txn.get(marketRef.collection('members').doc(id))
            const name = memberDoc.exists ? memberDoc.data()!.displayName : 'A member'
            throw new HttpsError(
              'failed-precondition',
              `${name} has already placed trades and cannot be excluded`,
            )
          }
        }
      }

      updates.excludedMembers = newExcluded
    }

    // Close date: can only extend (move further into future)
    if (closesAt !== undefined) {
      const newCloseDate = new Date(closesAt)
      if (isNaN(newCloseDate.getTime())) {
        throw new HttpsError('invalid-argument', 'Invalid close date')
      }
      const currentCloseTime = bet.closesAt.toDate().getTime()
      if (newCloseDate.getTime() <= currentCloseTime) {
        throw new HttpsError(
          'failed-precondition',
          'Close date can only be extended, not shortened',
        )
      }
      updates.closesAt = Timestamp.fromDate(newCloseDate)
    }

    if (Object.keys(updates).length === 0) {
      throw new HttpsError('invalid-argument', 'No changes provided')
    }

    txn.update(betRef, updates)
  })

  return { success: true }
})

export const addComment = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, betId, text, imageUrl, database } = request.data as {
    marketId: string
    betId: string
    text: string
    imageUrl?: string
    database?: string
  }
  const db = getDb(database)

  if (!marketId || !betId) {
    throw new HttpsError('invalid-argument', 'Market ID and bet ID are required')
  }
  const trimmedText = text && typeof text === 'string' ? text.trim() : ''
  const hasImage = typeof imageUrl === 'string' && imageUrl.length > 0
  if (!trimmedText && !hasImage) {
    throw new HttpsError('invalid-argument', 'Comment must include text or an image')
  }
  if (trimmedText.length > 500) {
    throw new HttpsError('invalid-argument', 'Comment must be 500 characters or fewer')
  }
  if (hasImage && !imageUrl.startsWith('https://firebasestorage.googleapis.com/')) {
    throw new HttpsError('invalid-argument', 'Invalid image URL')
  }

  const marketRef = db.collection('markets').doc(marketId)
  const betRef = marketRef.collection('bets').doc(betId)

  // Verify membership
  const memberDoc = await marketRef.collection('members').doc(uid).get()
  if (!memberDoc.exists) {
    throw new HttpsError('permission-denied', 'You are not a member of this market')
  }

  // Verify bet exists
  const betDoc = await betRef.get()
  if (!betDoc.exists) {
    throw new HttpsError('not-found', 'Bet not found')
  }

  // Write comment and update bet atomically
  const commentRef = betRef.collection('comments').doc()
  const commentData: Record<string, unknown> = {
    userId: uid,
    text: trimmedText,
    createdAt: FieldValue.serverTimestamp(),
  }
  if (hasImage) {
    commentData.imageUrl = imageUrl
  }
  const batch = db.batch()
  batch.set(commentRef, commentData)
  batch.update(betRef, {
    commentCount: FieldValue.increment(1),
    lastCommentAt: FieldValue.serverTimestamp(),
  })
  await batch.commit()

  return { commentId: commentRef.id }
})

export const checkResolutionNeeded = onSchedule('every 5 minutes', async () => {
  const now = Timestamp.now()

  // Check both databases
  for (const dbName of ALLOWED_DBS) {
    const db = getDb(dbName)

    // Find all markets
    const marketsSnap = await db.collection('markets').get()
    for (const marketDoc of marketsSnap.docs) {
      const marketId = marketDoc.id

      // Find open bets past their close time that haven't been notified yet
      const betsSnap = await db
        .collection('markets')
        .doc(marketId)
        .collection('bets')
        .where('status', '==', 'open')
        .where('closesAt', '<=', now)
        .get()

      for (const betDoc of betsSnap.docs) {
        const bet = betDoc.data()

        // Skip if already notified
        if (bet.resolutionNotifiedAt) continue

        // Mark as notified to prevent repeat notifications
        await betDoc.ref.update({ resolutionNotifiedAt: FieldValue.serverTimestamp() })

        // Send push to the bet creator
        sendPushToUsers(
          db,
          marketId,
          [bet.createdBy],
          {
            title: 'Betting closed',
            body: `"${bet.question}" needs resolution`,
          },
          { betId: betDoc.id, type: 'resolution_needed', marketId },
        ).catch(() => {})
      }
    }
  }
})

/**
 * One-time callable to backfill stats for all resolved bets in a market.
 * Iterates resolved bets chronologically and builds stats from scratch.
 */
export const backfillStats = onCall(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in')

  const { marketId, database } = request.data as {
    marketId: string
    database?: string
  }
  const db = getDb(database)

  if (!marketId) {
    throw new HttpsError('invalid-argument', 'Market ID is required')
  }

  // Verify caller is market owner
  const marketDoc = await db.collection('markets').doc(marketId).get()
  if (!marketDoc.exists) throw new HttpsError('not-found', 'Market not found')
  if (marketDoc.data()!.ownerId !== uid) {
    throw new HttpsError('permission-denied', 'Only the market owner can backfill stats')
  }

  const marketRef = db.collection('markets').doc(marketId)

  // Get all resolved bets ordered chronologically
  const allBetsSnap = await marketRef.collection('bets').orderBy('createdAt', 'asc').get()

  const resolvedBetDocs = allBetsSnap.docs.filter((d) => d.data().status === 'resolved')

  // Accumulate stats per user
  const userRecords = new Map<string, ResolvedBetRecord[]>()

  for (const betDoc of resolvedBetDocs) {
    const bet = betDoc.data()
    const winningOutcome: number = bet.resolvedOutcome

    // Read positions for this bet
    const posSnap = await betDoc.ref.collection('positions').get()

    // Read trades for entry probability
    const tradesSnap = await betDoc.ref.collection('trades').orderBy('createdAt', 'asc').get()
    const userFirstTrade = new Map<string, { priceAfter: number[] }>()
    for (const tDoc of tradesSnap.docs) {
      const t = tDoc.data()
      if (!userFirstTrade.has(t.userId)) {
        userFirstTrade.set(t.userId, { priceAfter: t.priceAfter })
      }
    }

    for (const posDoc of posSnap.docs) {
      const pos = posDoc.data()
      const shares: number[] = pos.shares ?? []
      const totalShares = shares.reduce((s, v) => s + v, 0)
      if (totalShares <= 0 && pos.totalCost <= 0) continue

      const userId = posDoc.id
      const payout = shares[winningOutcome] ?? 0
      const profit = payout - pos.totalCost

      const primaryOutcome = shares.reduce((best, s, i) => (s > (shares[best] ?? 0) ? i : best), 0)

      const firstTrade = userFirstTrade.get(userId)
      const entryPrices = firstTrade?.priceAfter ?? []
      const entryProbability = entryPrices[primaryOutcome] ?? 1 / (bet.outcomes.length || 2)

      let wasFavorite = false
      if (entryPrices.length > 0) {
        const maxPrice = Math.max(...entryPrices)
        wasFavorite = (entryPrices[primaryOutcome] ?? 0) >= maxPrice - 0.001
      }

      const record: ResolvedBetRecord = {
        betId: betDoc.id,
        question: bet.question,
        resolvedAt: bet.createdAt, // use bet createdAt as approximation
        totalCost: pos.totalCost,
        payout,
        profit,
        entryProbability,
        primaryOutcome,
        winningOutcome,
        wasFavorite,
      }

      const existing = userRecords.get(userId) ?? []
      existing.push(record)
      userRecords.set(userId, existing)
    }
  }

  // Write all stats docs
  const batch = db.batch()
  let count = 0
  for (const [userId, records] of userRecords) {
    const statsComputed = recomputeStats(records)
    batch.set(marketRef.collection('stats').doc(userId), {
      resolvedBets: records,
      ...statsComputed,
    })
    count++
  }
  await batch.commit()

  return { success: true, usersUpdated: count, betsProcessed: resolvedBetDocs.length }
})
