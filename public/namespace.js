"use strict";
function clearAccessFragment() {
  if (new URLSearchParams(window.location.hash.slice(1)).has("access")) {
    window.history.replaceState({}, "", window.location.pathname + window.location.search);
  }
}
clearAccessFragment();
window.addEventListener("DOMContentLoaded", clearAccessFragment, {once: true});
window.addEventListener("pageshow", clearAccessFragment);
window.addEventListener("hashchange", clearAccessFragment);
