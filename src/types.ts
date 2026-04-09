import type { Timestamp } from 'firebase/firestore'

export interface Market {
  id: string
  name: string
  ownerId: string
  inviteCode: string
  defaultBalance: number
  liquidityParam: number
  createdAt: Timestamp
}

export interface Member {
  userId: string
  displayName: string
  photoURL: string | null
  balance: number
  joinedAt: Timestamp
}

export interface Bet {
  id: string
  question: string
  type: 'binary' | 'multiple_choice'
  outcomes: string[]
  createdBy: string
  excludedMembers: string[]
  status: 'open' | 'closed' | 'resolved' | 'cancelled'
  resolvedOutcome: number | null
  closesAt: Timestamp
  createdAt: Timestamp
  liquidityParam: number
  sharesSold: number[]
  totalVolume: number
}

export interface Position {
  userId: string
  shares: number[]
  totalCost: number
}

export interface Trade {
  id: string
  userId: string
  outcomeIndex: number
  shares: number
  cost: number
  priceAfter: number[]
  createdAt: Timestamp
}

export interface ResolvedBetRecord {
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

export interface UserStats {
  resolvedBets: ResolvedBetRecord[]
  totalResolved: number
  wins: number
  totalWagered: number
  totalProfit: number
  currentStreak: { type: 'win' | 'loss'; count: number }
  bestBet: { betId: string; question: string; profit: number } | null
  worstBet: { betId: string; question: string; profit: number } | null
  biggestUpset: { betId: string; question: string; entryProbability: number; profit: number } | null
  avgBetSize: number
  favoriteRate: number
}

export type NotificationType =
  | 'bet_created'
  | 'bet_resolved'
  | 'bet_cancelled'
  | 'resolution_needed'

export interface AppNotification {
  id: string
  type: NotificationType
  betId: string
  title: string
  body: string
  createdAt: number
}
