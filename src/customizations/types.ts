/**
 * Customization types for ahpx workspace discovery.
 *
 * AHP 0.5.0 models published customizations as [Open Plugins](https://open-plugins.com/)
 * containers (`ClientPluginCustomization`), which the host expands into typed
 * children. ahpx discovers individual workspace files (instructions, agents,
 * prompts, skills) and publishes each as a plugin container.
 *
 * This module keeps a thin ahpx-local descriptor (`CustomizationRef`) for the
 * discovery layer and maps it to the official wire shape at the dispatch
 * boundary via {@link toClientCustomization}.
 */

import type { SessionActiveClient, URI } from "@microsoft/agent-host-protocol";

/** The customization shape a client publishes in `activeClient.customizations`. */
export type ClientCustomization = NonNullable<SessionActiveClient["customizations"]>[number];

/** `CustomizationType.Plugin` is a const enum; its wire value is `"plugin"`. */
const PLUGIN_TYPE = "plugin" as ClientCustomization["type"];

/**
 * An optionally-sized icon that can be displayed in a user interface.
 */
export interface Icon {
	/** A URI pointing to an icon resource (HTTP(S) URL or `data:` URI). */
	src: URI;
	/** Optional MIME type override (e.g. `"image/png"`). */
	contentType?: string;
	/** Optional sizes the icon can be used at (e.g. `"48x48"`, `"any"`). */
	sizes?: string[];
	/** Optional theme the icon is designed for. */
	theme?: "light" | "dark";
}

/**
 * A reference to a workspace customization discovered by ahpx.
 *
 * Thin descriptor produced by the discovery layer and mapped to the official
 * {@link ClientCustomization} shape before dispatch.
 */
export interface CustomizationRef {
	/** Source URI for the customization (a `file://` URI). */
	uri: URI;
	/** Human-readable name. */
	displayName: string;
	/** Description of what the customization provides. */
	description?: string;
	/** Icons for UI display. */
	icons?: Icon[];
	/** Opaque version token used to detect content changes. */
	nonce?: string;
}

/**
 * Map an ahpx {@link CustomizationRef} to the official
 * {@link ClientCustomization} (Open Plugins container) wire shape.
 */
export function toClientCustomization(ref: CustomizationRef): ClientCustomization {
	return {
		id: ref.uri,
		type: PLUGIN_TYPE,
		uri: ref.uri,
		name: ref.displayName,
		enabled: true,
		...(ref.icons ? { icons: ref.icons } : {}),
		...(ref.nonce ? { nonce: ref.nonce } : {}),
	};
}
