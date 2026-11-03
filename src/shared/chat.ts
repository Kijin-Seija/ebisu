/**
 * Agent 对话频道：跨设备复制的只追加消息流。
 * 频道由参与设备共同持有完整副本，agent 只访问本机 Ebisu；设备之间经已配对的 mTLS 通道同步。
 */
export interface ChatChannel {
  /** 频道标识，例如 control、bug/STRATEGY-4287；跨设备唯一。 */
  id: string
  title: string
  /** 持有副本的设备 ID；只增不减，合并时取并集。 */
  devices: string[]
  /** 出现过的参与者名称（如 almon-mini/qoder）；只增不减。 */
  members: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}
export interface ChatMessage {
  /** 本机接收顺序；只在本机有效，用于长轮询游标。 */
  seq: number
  /** `${origin}:${counter}`，在频道内全局唯一。 */
  id: string
  channel: string
  /** 写入该消息的设备 ID。 */
  origin: string
  /** 来源设备在该频道内的连续计数，从 1 开始，用于版本向量补齐。 */
  counter: number
  from: string
  to: string | null
  type: string
  body: string
  replyTo: string | null
  /** 调用方提供的幂等键；同一来源设备、同一频道内重复提交返回原消息。 */
  clientId: string | null
  /** 来源设备写入时间。 */
  createdAt: number
  /** 本机收到时间。 */
  receivedAt: number
}
/** 频道删除标记：跨设备复制，阻止旧副本让已删除频道复活；创建时间晚于删除时间的频道视为重建。 */
export interface ChatTombstone {
  id: string
  deletedAt: number
  /** 执行删除的设备 ID。 */
  deletedBy: string
  /** 删除时持有副本的设备，删除标记只传播给这些设备。 */
  devices: string[]
}
export interface ChatChannelSummary extends ChatChannel {
  count: number
  last: ChatMessage | null
}
export interface ChatDevice {
  id: string
  name: string
  self: boolean
  online: boolean
}
