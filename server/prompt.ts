export function buildMessages(prompt: string, currentHtml?: string) {
  return [{
    role: 'user',
    content: currentHtml
      ? `Here is the current app:\n${currentHtml}\n\nChange it: ${prompt}. Return the complete updated HTML file.`
      : prompt,
  }];
}
