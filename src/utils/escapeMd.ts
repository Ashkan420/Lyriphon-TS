export function escapeMd(text: string): string {
  const escapeChars = /([\\_\*\[\]\(\)~`>#+\-=|{}\.\!])/g;
  return text.replace(escapeChars, "\\$1");
}
