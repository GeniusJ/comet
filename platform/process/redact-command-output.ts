import { stripVTControlCharacters } from 'node:util';

export function redactCommandOutput(value: string, environment = process.env): string {
  let result = stripVTControlCharacters(value)
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1[redacted]')
    .replace(
      /((?:api[_-]?key|auth[_-]?token|access[_-]?token|_authToken|password|secret)\s*[=:]\s*["']?)[^\s"',}]+/giu,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/[^\s/:]+:)[^\s@]+@/giu, '$1[redacted]@');
  for (const [key, secret] of Object.entries(environment)) {
    if (secret && secret.length >= 6 && /key|token|password|secret|credential/iu.test(key))
      result = result.split(secret).join('[redacted]');
  }
  return result;
}
