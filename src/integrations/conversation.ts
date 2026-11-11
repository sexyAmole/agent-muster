export function groupConversationKey(chatId: string, senderId: string): string {
  if (!senderId) throw new Error('群聊消息缺少发送人标识');
  return `group:${JSON.stringify([chatId, senderId])}`;
}

export function conversationChatId(conversation: string): string {
  if (!conversation.startsWith('group:')) return conversation;
  const [chatId] = JSON.parse(conversation.slice('group:'.length)) as [string, string];
  return chatId;
}
