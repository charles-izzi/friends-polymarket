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
