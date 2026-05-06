/**
 * Reverse a single trade on an open bet.
 * Undoes all side-effects of executeTrade: bet sharesSold/totalVolume,
 * member balance, user position, and the trade document itself.
 *
 * Usage:
 *   npx ts-node src/reverse-trade.ts <database> <marketId> <betId> <tradeId> [--dry-run]
 *
 * Examples:
 *   npx ts-node src/reverse-trade.ts staging abc123 bet456 trade789
 *   npx ts-node src/reverse-trade.ts '(default)' abc123 bet456 trade789 --dry-run
 */

import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { calcEffectiveB, calcPrices, rescaleShares } from './lmsr'

// ---- CLI args ----
const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')

if (positional.length < 4) {
  console.error(
    'Usage: npx ts-node src/reverse-trade.ts <database> <marketId> <betId> <tradeId> [--dry-run]',
  )
  process.exit(1)
}

const [dbName, marketId, betId, tradeId] = positional

if (!['staging', '(default)'].includes(dbName)) {
  console.error(`Invalid database "${dbName}". Must be "staging" or "(default)"`)
  process.exit(1)
}

initializeApp()

const db = dbName === '(default)' ? getFirestore() : getFirestore(dbName)

async function main() {
  console.log(`\n=== Reverse Trade ===`)
  console.log(`Database: ${dbName}`)
  console.log(`Market:   ${marketId}`)
  console.log(`Bet:      ${betId}`)
  console.log(`Trade:    ${tradeId}`)
  console.log(`Mode:     ${dryRun ? 'DRY RUN (no writes)' : 'LIVE — will write to Firestore'}\n`)

  const marketRef = db.collection('markets').doc(marketId)
  const betRef = marketRef.collection('bets').doc(betId)
  const tradeRef = betRef.collection('trades').doc(tradeId)

  // Fetch the trade
  const tradeSnap = await tradeRef.get()
  if (!tradeSnap.exists) {
    console.error(`ERROR: Trade "${tradeId}" not found.`)
    process.exit(1)
  }
  const trade = tradeSnap.data()!
  const { userId, outcomeIndex, shares, cost } = trade as {
    userId: string
    outcomeIndex: number
    shares: number
    cost: number
  }

  // Verify this is the latest trade on the bet
  const latestTradeSnap = await betRef
    .collection('trades')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
  if (latestTradeSnap.empty || latestTradeSnap.docs[0].id !== tradeId) {
    console.error(
      `ERROR: Trade "${tradeId}" is not the latest trade on this bet. ` +
        `Latest is "${latestTradeSnap.docs[0]?.id}". Only the most recent trade can be reversed.`,
    )
    process.exit(1)
  }

  console.log(`Trade details:`)
  console.log(`  User:          ${userId}`)
  console.log(`  Outcome index: ${outcomeIndex}`)
  console.log(`  Shares:        ${shares}`)
  console.log(`  Cost:          ${cost.toFixed(4)}`)

  // Fetch the bet
  const betSnap = await betRef.get()
  if (!betSnap.exists) {
    console.error(`ERROR: Bet "${betId}" not found.`)
    process.exit(1)
  }
  const bet = betSnap.data()!

  if (bet.status !== 'open') {
    console.error(`ERROR: Bet status is "${bet.status}" — must be "open" to reverse a trade.`)
    process.exit(1)
  }

  const currentSharesSold: number[] = bet.sharesSold
  const currentTotalVolume: number = bet.totalVolume ?? 0
  const bMax: number = bet.liquidityParam

  console.log(`\nBet state before reversal:`)
  console.log(`  Total volume:  ${currentTotalVolume}`)
  console.log(`  Shares sold:   [${currentSharesSold.map((s) => s.toFixed(2)).join(', ')}]`)

  // Reverse the LMSR state:
  // When the trade was executed:
  //   1. cost was computed at bBefore = calcEffectiveB(totalVolumeBefore, bMax)
  //   2. postTradeShares[outcomeIndex] += shares
  //   3. newTotalVolume = totalVolumeBefore + |shares|
  //   4. bAfter = calcEffectiveB(newTotalVolume, bMax)
  //   5. newSharesSold = rescaleShares(postTradeShares, bBefore, bAfter)
  //
  // To reverse (current state = after trade):
  //   currentTotalVolume = totalVolumeBefore + |shares|
  //   bAfter (current) = calcEffectiveB(currentTotalVolume, bMax)
  //   totalVolumeBefore = currentTotalVolume - |shares|
  //   bBefore = calcEffectiveB(totalVolumeBefore, bMax)
  //   Un-rescale: postTradeShares = rescaleShares(currentSharesSold, bAfter, bBefore)
  //   Remove the trade: originalShares = postTradeShares; originalShares[outcomeIndex] -= shares
  //   That gives us the sharesSold BEFORE the trade — but at bBefore's scale.
  //   We want to store them at bBefore scale (since that's what they were at before).

  const newTotalVolume = currentTotalVolume - Math.abs(shares)
  if (newTotalVolume < 0) {
    console.error(`ERROR: Reversing would bring totalVolume below 0. Aborting.`)
    process.exit(1)
  }

  const bAfter = calcEffectiveB(currentTotalVolume, bMax)
  const bBefore = calcEffectiveB(newTotalVolume, bMax)

  // Un-rescale from bAfter back to bBefore to get the post-trade shares in bBefore's frame
  const postTradeSharesAtBBefore = rescaleShares(currentSharesSold, bAfter, bBefore)

  // Remove the trade's shares
  const restoredSharesSold = [...postTradeSharesAtBBefore]
  restoredSharesSold[outcomeIndex] -= shares

  console.log(`\nBet state after reversal:`)
  console.log(`  Total volume:  ${newTotalVolume}`)
  console.log(`  Shares sold:   [${restoredSharesSold.map((s) => s.toFixed(2)).join(', ')}]`)
  console.log(`  Prices:        [${calcPrices(restoredSharesSold, bBefore).map((p) => p.toFixed(4)).join(', ')}]`)

  // Fetch member
  const memberRef = marketRef.collection('members').doc(userId)
  const memberSnap = await memberRef.get()
  if (!memberSnap.exists) {
    console.error(`ERROR: Member "${userId}" not found in market.`)
    process.exit(1)
  }
  const member = memberSnap.data()!
  const newBalance = member.balance + cost

  console.log(`\nMember balance:`)
  console.log(`  Before: ${member.balance.toFixed(4)}`)
  console.log(`  After:  ${newBalance.toFixed(4)} (refund ${cost.toFixed(4)})`)

  // Fetch position
  const positionRef = betRef.collection('positions').doc(userId)
  const positionSnap = await positionRef.get()
  if (!positionSnap.exists) {
    console.error(`ERROR: Position for user "${userId}" not found on bet.`)
    process.exit(1)
  }
  const position = positionSnap.data()!
  const newShares = [...position.shares]
  newShares[outcomeIndex] -= shares
  const newTotalCost = position.totalCost - cost

  // Check for negative shares (shouldn't happen but sanity check)
  if (newShares[outcomeIndex] < -0.001) {
    console.error(
      `ERROR: Reversing would result in negative shares (${newShares[outcomeIndex]}). Aborting.`,
    )
    process.exit(1)
  }
  // Clamp near-zero to 0
  if (Math.abs(newShares[outcomeIndex]) < 0.001) {
    newShares[outcomeIndex] = 0
  }

  const positionEmpty = newShares.every((s) => Math.abs(s) < 0.001) && Math.abs(newTotalCost) < 0.001

  console.log(`\nPosition:`)
  console.log(`  Shares before: [${position.shares.join(', ')}]`)
  console.log(`  Shares after:  [${newShares.join(', ')}]`)
  console.log(`  Total cost:    ${position.totalCost.toFixed(4)} → ${newTotalCost.toFixed(4)}`)
  if (positionEmpty) {
    console.log(`  (Position will be DELETED — all zeroes)`)
  }

  if (dryRun) {
    console.log(`\n--- DRY RUN complete. No changes made. ---\n`)
    return
  }

  // Execute writes in a batch
  const batch = db.batch()

  // 1. Update bet
  batch.update(betRef, {
    sharesSold: restoredSharesSold,
    totalVolume: newTotalVolume,
  })

  // 2. Update member balance
  batch.update(memberRef, { balance: newBalance })

  // 3. Update or delete position
  if (positionEmpty) {
    batch.delete(positionRef)
  } else {
    batch.set(positionRef, {
      userId,
      shares: newShares,
      totalCost: newTotalCost,
    })
  }

  // 4. Delete trade
  batch.delete(tradeRef)

  await batch.commit()

  console.log(`\n✓ Trade reversed successfully.\n`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
