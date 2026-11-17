/** Only the Figma UI parent may drive panel or relay control messages. */
export function isMessageFromParent(event: MessageEvent): boolean {
  return event.source === window.parent;
}
