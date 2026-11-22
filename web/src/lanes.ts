interface LaneContext {
  html: string;
  conversationId: string;
  // The latest solo preview revision represented by this lane.
  soloRevision: number;
}

export function syncRaceLanes(
  cerebras: LaneContext,
  compare: LaneContext,
  newConversationId: string,
): [LaneContext, LaneContext] {
  if (cerebras.html && (!compare.html || cerebras.soloRevision > compare.soloRevision)) {
    return [cerebras, { html: cerebras.html, conversationId: newConversationId, soloRevision: cerebras.soloRevision }];
  }
  if (!cerebras.html && compare.html) {
    return [{ html: compare.html, conversationId: newConversationId, soloRevision: compare.soloRevision }, compare];
  }
  return [cerebras, compare];
}
