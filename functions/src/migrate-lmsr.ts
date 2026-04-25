/**
 * Migration script: Replay all trades with the current LMSR formula
 * (rescaleShares + B_MIN=60) and rewrite costs, positions, balances, and stats.
 *
 * Usage:
 *   npx ts-node src/migrate-lmsr.ts staging       # run on staging
 *   npx ts-node src/migrate-lmsr.ts '(default)'   # run on production
 *
 * Add --dry-run to preview without writing:
 *   npx ts-node src/migrate-lmsr.ts staging --dry-run
 */

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { calcCost, calcPrices, calcEffectiveB, rescaleShares } from './lmsr'

// ---- CLI args ----
const args = process.argv.slice(2)
const dbName = args.find((a) => !a.startsWith('--')) ?? '(default)'
const dryRun = args.includes('--dry-run')

if (!['staging', '(default)'].includes(dbName)) {
  console.error('Usage: npx ts-node src/migrate-lmsr.ts <staging|(default)> [--dry-run]')
  process.exit(1)
}

console.log(`\n=== LMSR Migration ===`)
console.log(`Database: ${dbName}`)
console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE — will write to Firestore'}\n`)

// ---- Stats types (mirrored from index.ts) ----
interface ResolvedBetRecord {
  betId: string
  question: string
  resolvedAt: Timestamp
  totalCost: number
  payout: number
  profit: number
  entryProbability: number
  primaryOutcome: number
  winningOutcome: number
  balanceAfter: number
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

// ---- Main migration ----
async function main() {
  initializeApp({ projectId: 'internal-polymarket' })
  const db = dbName === '(default)' ? getFirestore() : getFirestore(dbName)

  // Collect all writes as {ref, data, type} and commit in chunks of 500
  const writes: {
    ref: FirebaseFirestore.DocumentReference
    data: Record<string, unknown>
    type: 'update' | 'set'
  }[] = []

  const marketsSnap = await db.collection('markets').get()
  console.log(`Found ${marketsSnap.size} market(s)\n`)

  for (const marketDoc of marketsSnap.docs) {
    const market = marketDoc.data()
    const marketRef = marketDoc.ref
    const defaultBalance: number = market.defaultBalance ?? 0
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Market: "${market.name}" (${marketDoc.id})`)
    console.log(`  defaultBalance: $${defaultBalance}`)

    // --- Phase 1: Replay all trades per bet ---
    const betsSnap = await marketRef.collection('bets').orderBy('createdAt', 'asc').get()
    console.log(`  Bets: ${betsSnap.size}`)

    // Accumulate per-user balance deltas from trade cost changes
    // delta = oldCost - newCost (positive means user gets money back)
    const userBalanceDeltas = new Map<string, number>()
    // Track new position totalCost per bet per user
    const betPositionCosts = new Map<string, Map<string, number>>() // betId -> userId -> newTotalCost
    // Cache first priceAfter per user per bet (for stats rebuild)
    const betFirstPriceAfter = new Map<string, Map<string, number[]>>() // betId -> userId -> priceAfter
    // Cache per-bet trade data for invalidation in stats phase
    const betTradeData = new Map<
      string,
      {
        userId: string
        outcomeIndex: number
        shares: number
        cost: number
        createdAt: FirebaseFirestore.Timestamp
      }[]
    >()

    let writeCount = 0

    for (const betDoc of betsSnap.docs) {
      const bet = betDoc.data()
      const betRef = betDoc.ref
      const numOutcomes: number = bet.outcomes.length
      const bMax: number = bet.liquidityParam

      // Read all trades in chronological order
      const tradesSnap = await betRef.collection('trades').orderBy('createdAt', 'asc').get()
      if (tradesSnap.empty) continue

      console.log(
        `\n  Bet: "${bet.question}" (${betDoc.id}) — ${tradesSnap.size} trades, status=${bet.status}`,
      )

      // Replay trades with new LMSR
      let sharesSold = new Array(numOutcomes).fill(0)
      let totalVolume = 0
      const userNewCosts = new Map<string, number>() // userId -> sum of new costs
      const userNewShares = new Map<string, number[]>() // userId -> shares array
      let firstPriceAfterPerUser = new Map<string, number[]>()

      for (const tradeDoc of tradesSnap.docs) {
        const trade = tradeDoc.data()
        const userId: string = trade.userId
        const outcomeIndex: number = trade.outcomeIndex
        const shares: number = trade.shares
        const oldCost: number = trade.cost

        // Compute new cost using current LMSR with rescaling
        const bBefore = calcEffectiveB(totalVolume, bMax)
        const newCost = calcCost(sharesSold, outcomeIndex, shares, bBefore)

        // Compute post-trade state with rescaling
        const postTradeShares = [...sharesSold]
        postTradeShares[outcomeIndex] = (postTradeShares[outcomeIndex] ?? 0) + shares
        const newTotalVolume = totalVolume + Math.abs(shares)
        const bAfter = calcEffectiveB(newTotalVolume, bMax)
        const newSharesSold = rescaleShares(postTradeShares, bBefore, bAfter)
        const newPriceAfter = calcPrices(newSharesSold, bAfter)

        // Track balance delta (positive delta = user saves money)
        const costDiff = oldCost - newCost
        userBalanceDeltas.set(userId, (userBalanceDeltas.get(userId) ?? 0) + costDiff)

        // Track per-user position costs
        userNewCosts.set(userId, (userNewCosts.get(userId) ?? 0) + newCost)

        // Track per-user shares (positions — these don't change, just verify)
        if (!userNewShares.has(userId)) {
          userNewShares.set(userId, new Array(numOutcomes).fill(0))
        }
        const uShares = userNewShares.get(userId)!
        uShares[outcomeIndex] = (uShares[outcomeIndex] ?? 0) + shares

        // Track first trade priceAfter per user (for stats)
        if (!firstPriceAfterPerUser.has(userId)) {
          firstPriceAfterPerUser.set(userId, newPriceAfter)
        }

        // Log significant cost changes
        if (Math.abs(costDiff) > 0.01) {
          console.log(
            `    Trade ${tradeDoc.id}: ${shares > 0 ? 'BUY' : 'SELL'} ${Math.abs(shares)} of option ${outcomeIndex} by ${userId.slice(0, 8)}..  old=$${oldCost.toFixed(2)} -> new=$${newCost.toFixed(2)} (Δ${costDiff >= 0 ? '+' : ''}$${costDiff.toFixed(2)})`,
          )
        }

        // Update trade doc
        writes.push({
          ref: tradeDoc.ref,
          data: { cost: newCost, priceAfter: newPriceAfter },
          type: 'update',
        })
        writeCount++

        // Cache trade data for stats phase
        if (!betTradeData.has(betDoc.id)) betTradeData.set(betDoc.id, [])
        betTradeData.get(betDoc.id)!.push({
          userId,
          outcomeIndex,
          shares,
          cost: newCost,
          createdAt: trade.createdAt,
        })

        // Advance state
        sharesSold = newSharesSold
        totalVolume = newTotalVolume
      }

      // Update bet document with final LMSR state
      writes.push({ ref: betRef, data: { sharesSold, totalVolume }, type: 'update' })
      writeCount++

      // Update positions for this bet
      const positionsSnap = await betRef.collection('positions').get()
      const positionCosts = new Map<string, number>()
      for (const posDoc of positionsSnap.docs) {
        const userId = posDoc.id
        const newTotalCost = userNewCosts.get(userId) ?? 0
        const oldTotalCost: number = posDoc.data().totalCost

        writes.push({ ref: posDoc.ref, data: { totalCost: newTotalCost }, type: 'update' })
        writeCount++
        positionCosts.set(userId, newTotalCost)

        if (Math.abs(oldTotalCost - newTotalCost) > 0.01) {
          console.log(
            `    Position ${userId.slice(0, 8)}..: totalCost $${oldTotalCost.toFixed(2)} -> $${newTotalCost.toFixed(2)}`,
          )
        }
      }
      betPositionCosts.set(betDoc.id, positionCosts)
      betFirstPriceAfter.set(betDoc.id, firstPriceAfterPerUser)
    }

    // --- Phase 2: Recalculate member balances ---
    // Balance = defaultBalance - Σ(trade costs) + Σ(resolved payouts) + Σ(cancelled refunds)
    // Since positions.totalCost is being recalculated, we rebuild from scratch

    console.log(`\n  Recalculating balances...`)
    const membersSnap = await marketRef.collection('members').get()

    // Start from defaultBalance, subtract new total costs for all open/closed bets,
    // and add payouts for resolved bets, and refund cancelled bet costs
    for (const memberDoc of membersSnap.docs) {
      const userId = memberDoc.id
      const oldBalance: number = memberDoc.data().balance
      const delta = userBalanceDeltas.get(userId) ?? 0
      const newBalance = oldBalance + delta

      if (Math.abs(delta) > 0.01) {
        console.log(
          `    Member ${userId.slice(0, 8)}..: balance $${oldBalance.toFixed(2)} -> $${newBalance.toFixed(2)} (Δ${delta >= 0 ? '+' : ''}$${delta.toFixed(2)})`,
        )
      }

      writes.push({ ref: memberDoc.ref, data: { balance: newBalance }, type: 'update' })
      writeCount++
    }

    // --- Phase 3: Rebuild stats for resolved bets ---
    console.log(`\n  Rebuilding stats...`)

    const memberBalances = new Map<string, number>()
    for (const m of membersSnap.docs) {
      memberBalances.set(m.id, defaultBalance)
    }

    // Walk all bets chronologically to build running balances for balanceAfter
    const userRecords = new Map<string, ResolvedBetRecord[]>()

    for (const betDoc of betsSnap.docs) {
      const bet = betDoc.data()
      const status: string = bet.status

      // For running balance: subtract trade costs for ALL bets
      const positions = betPositionCosts.get(betDoc.id)
      if (positions) {
        for (const [userId, cost] of positions) {
          const prev = memberBalances.get(userId) ?? defaultBalance
          memberBalances.set(userId, prev - cost)
        }
      }

      if (status === 'resolved') {
        const winningOutcome: number = bet.resolvedOutcome
        const posSnap = await betDoc.ref.collection('positions').get()

        // Use cached first priceAfter per user from Phase 1
        const userFirstTrade = betFirstPriceAfter.get(betDoc.id) ?? new Map()

        // Handle resolvesAt invalidation using cached trade data
        const resolveCutoff = bet.resolvesAt ? bet.resolvesAt : null
        const invalidatedCostPerUser = new Map<string, number>()
        const invalidatedSharesPerUser = new Map<string, number[]>()
        if (resolveCutoff) {
          const trades = betTradeData.get(betDoc.id) ?? []
          for (const t of trades) {
            if (t.createdAt && t.createdAt.toMillis() > resolveCutoff.toMillis()) {
              invalidatedCostPerUser.set(
                t.userId,
                (invalidatedCostPerUser.get(t.userId) ?? 0) + t.cost,
              )
              if (!invalidatedSharesPerUser.has(t.userId)) {
                invalidatedSharesPerUser.set(t.userId, new Array(bet.outcomes.length).fill(0))
              }
              const sh = invalidatedSharesPerUser.get(t.userId)!
              sh[t.outcomeIndex] = (sh[t.outcomeIndex] ?? 0) + t.shares
            }
          }
        }

        for (const posDoc of posSnap.docs) {
          const pos = posDoc.data()
          const rawShares: number[] = pos.shares ?? []
          const newTotalCost = betPositionCosts.get(betDoc.id)?.get(posDoc.id) ?? pos.totalCost
          const totalShares = rawShares.reduce((s, v) => s + v, 0)
          if (totalShares <= 0 && newTotalCost <= 0) continue

          const userId = posDoc.id

          const invShares = invalidatedSharesPerUser.get(userId)
          const invCost = invalidatedCostPerUser.get(userId) ?? 0
          const validShares = invShares
            ? rawShares.map((s, i) => s - (invShares[i] ?? 0))
            : rawShares
          const validCost = newTotalCost - invCost

          const payout = validShares[winningOutcome] ?? 0
          const profit = payout - validCost

          const primaryOutcome = validShares.reduce(
            (best, s, i) => (s > (validShares[best] ?? 0) ? i : best),
            0,
          )

          const entryPrices = userFirstTrade.get(userId) ?? []
          const entryProbability = entryPrices[primaryOutcome] ?? 1 / (bet.outcomes.length || 2)

          let wasFavorite = false
          if (entryPrices.length > 0) {
            const maxPrice = Math.max(...entryPrices)
            wasFavorite = (entryPrices[primaryOutcome] ?? 0) >= maxPrice - 0.001
          }

          // Add payout + refund to running balance
          const prevBal = memberBalances.get(userId) ?? defaultBalance
          const balanceAfter = prevBal + payout + invCost
          memberBalances.set(userId, balanceAfter)

          const record: ResolvedBetRecord = {
            betId: betDoc.id,
            question: bet.question,
            resolvedAt: bet.createdAt,
            totalCost: validCost,
            payout,
            profit,
            entryProbability,
            primaryOutcome,
            winningOutcome,
            balanceAfter,
            wasFavorite,
          }

          const existing = userRecords.get(userId) ?? []
          existing.push(record)
          userRecords.set(userId, existing)
        }
      } else if (status === 'cancelled') {
        // Cancelled bets refund totalCost, so add it back to running balance
        const positions2 = betPositionCosts.get(betDoc.id)
        if (positions2) {
          for (const [userId, cost] of positions2) {
            const prev = memberBalances.get(userId) ?? defaultBalance
            memberBalances.set(userId, prev + cost)
          }
        }
      }
    }

    // Write stats
    let statsCount = 0
    for (const [userId, records] of userRecords) {
      const statsComputed = recomputeStats(records)
      writes.push({
        ref: marketRef.collection('stats').doc(userId),
        data: { resolvedBets: records, ...statsComputed },
        type: 'set',
      })
      writeCount++
      statsCount++
    }
    console.log(`    Stats rebuilt for ${statsCount} users`)

    // --- Commit ---
    console.log(`\n  Total writes: ${writeCount}`)
    if (dryRun) {
      console.log(`  DRY RUN — no changes written`)
    } else {
      // Commit in chunks of 500 (Firestore batch limit)
      console.log(`  Committing in ${Math.ceil(writeCount / 500)} batch(es)...`)
      for (let i = 0; i < writes.length; i += 500) {
        const chunk = writes.slice(i, i + 500)
        const batch = db.batch()
        for (const w of chunk) {
          if (w.type === 'set') {
            batch.set(w.ref, w.data)
          } else {
            batch.update(w.ref, w.data)
          }
        }
        await batch.commit()
        console.log(`    Committed batch ${Math.floor(i / 500) + 1} (${chunk.length} writes)`)
      }
      console.log(`  ✓ Done`)
    }
  }

  console.log(`\n=== Migration complete ===\n`)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
