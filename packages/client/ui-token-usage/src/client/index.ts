/**
 * Token-usage readout plugin, browser half: one `conversation.composer.dock`
 * entry that classifies the CURRENT conversation's durable token usage into
 * its four disjoint billing buckets and prices them with the host-registered
 * `tokenPricing` table.
 *
 * The plugin reads only framework hooks: `tokenUsage` (the exact whole-log
 * buckets), `modelSelection` (the route that produced them), and
 * `tokenPricing` (the deployment's price table). It owns no state, issues no
 * RPC, and adds no model-visible content.
 *
 * @module @deepseek-ai/dsh-client-ui-token-usage
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the UseProjection seat and the modelSelection projection key.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Conversation composer-dock slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard props seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { TokenUsageDock } from './TokenUsageDock.tsx'
import { en, NS, zh, type TokenUsageKey } from './locales.ts'

export type { TokenUsageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer-dock token-usage readout's copy. */
    tokenUsage: TokenUsageKey
  }
}

/** Required services for the readout: slot contribution and its dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the composer-dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-token-usage: dictionaries')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'token-usage',
    // After the chat stats pills: classification reads below the summary row.
    order: 10,
    locale: NS,
  }, TokenUsageDock))
}
