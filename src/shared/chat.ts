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
  /** 发送者使用的模型标识（如 claude-opus-4-6、gpt-5 等）；未知或未记录时省略。 */
  model?: string
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
  /** 图片附件；没有附件时省略。 */
  attachments?: ChatAttachment[]
}
/** 对话图片附件允许的类型；按文件头魔数识别，不信任扩展名。 */
export const chatImageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ChatImageMime = (typeof chatImageMimes)[number]
/**
 * 消息中的图片附件：按 sha256 内容寻址，随频道删除。
 * path/pending 只在本机输出时计算，不参与跨设备复制。
 */
export interface ChatAttachment {
  /** 文件内容的 sha256（小写十六进制）。 */
  hash: string
  name: string
  mime: ChatImageMime
  size: number
  /** 本机文件绝对路径；尚未从对端下载完成时为 null。 */
  path: string | null
  /** true 表示本机仍在等待从对端同步该图片。 */
  pending?: boolean
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
  /** 本机尚未下载完成的图片数量；下载完成后界面据此刷新。 */
  pendingFiles: number
}
export interface ChatDevice {
  id: string
  name: string
  self: boolean
  online: boolean
}
