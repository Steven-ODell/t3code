/**
 * Sao's private build never replaces itself. Packaged bundles get
 * `__T3CODE_SAO_PINNED__` from vite.config.ts; tests and `vp dev` do not, so
 * the update code keeps its upstream behaviour there. New versions come from
 * `t3-sao build && t3-sao install` in his dotfiles instead.
 */
declare const __T3CODE_SAO_PINNED__: boolean | undefined;

export const SELF_UPDATE_PINNED =
  typeof __T3CODE_SAO_PINNED__ !== "undefined" && __T3CODE_SAO_PINNED__ === true;

export const SELF_UPDATE_PINNED_REASON =
  "This is a private T3 Code build and does not update itself. Rebuild it with `t3-sao build && t3-sao install`.";
