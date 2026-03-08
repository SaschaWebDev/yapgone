import { z } from 'zod'

export interface MessageHeader {
  pubkey: string
  n: number
  pn: number
}

export type ClientMessage =
  | { type: 'pubkey'; key: string }
  | { type: 'message'; header: MessageHeader; payload: string }
  | { type: 'typing'; active: boolean }
  | { type: 'leave' }
  | { type: 'close-room' }

export type ServerMessage =
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'room-full' }
  | { type: 'room-expired' }
  | { type: 'error'; code: string; message: string }
  | { type: 'room-closed' }

const MessageHeaderSchema = z.object({
  pubkey: z.string(),
  n: z.number().int().nonnegative(),
  pn: z.number().int().nonnegative(),
})

const PubkeyMessageSchema = z.object({
  type: z.literal('pubkey'),
  key: z.string(),
})

const ChatMessageSchema = z.object({
  type: z.literal('message'),
  header: MessageHeaderSchema,
  payload: z.string(),
})

const TypingMessageSchema = z.object({
  type: z.literal('typing'),
  active: z.boolean(),
})

const LeaveMessageSchema = z.object({
  type: z.literal('leave'),
})

const CloseRoomMessageSchema = z.object({
  type: z.literal('close-room'),
})

export const ClientMessageSchema = z.discriminatedUnion('type', [
  PubkeyMessageSchema,
  ChatMessageSchema,
  TypingMessageSchema,
  LeaveMessageSchema,
  CloseRoomMessageSchema,
])

const PeerJoinedSchema = z.object({ type: z.literal('peer-joined') })
const PeerLeftSchema = z.object({ type: z.literal('peer-left') })
const RoomFullSchema = z.object({ type: z.literal('room-full') })
const RoomExpiredSchema = z.object({ type: z.literal('room-expired') })
const RoomClosedSchema = z.object({ type: z.literal('room-closed') })
const ErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
})

export const ServerMessageSchema = z.discriminatedUnion('type', [
  PeerJoinedSchema,
  PeerLeftSchema,
  RoomFullSchema,
  RoomExpiredSchema,
  RoomClosedSchema,
  ErrorSchema,
])
