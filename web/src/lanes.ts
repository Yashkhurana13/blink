interface LaneContext {
  html: string;
  conversationId: string;
}

export function syncRaceLanes(
  cerebras: LaneContext,
  compare: LaneContext,
  newConversationId: string,
  refreshCompare = false,
): [LaneContext, LaneContext] {
  if (cerebras.html && (!compare.html || refreshCompare)) {
    return [cerebras, { html: cerebras.html, conversationId: newConversationId }];
  }
  if (!cerebras.html && compare.html) {
    return [{ html: compare.html, conversationId: newConversationId }, compare];
  }
  return [cerebras, compare];
}
