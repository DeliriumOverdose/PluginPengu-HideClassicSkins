/**
 * @name Hide League Classic Skins
 * @author DeliriumOverdose
 */

const CLASSIC_CHAMPION_ID_MIN = 60000;
const CLASSIC_CHAMPION_ID_MAX = 69999;
const CLASSIC_SKIN_ITEM_ID_MIN = 60000000;
const CLASSIC_SKIN_ITEM_ID_MAX = 69999999;

const toInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

const isClassicChampionId = (value) => {
  const id = toInteger(value);
  return id !== null && id >= CLASSIC_CHAMPION_ID_MIN && id <= CLASSIC_CHAMPION_ID_MAX;
};

const isClassicSkinId = (value) => {
  const id = toInteger(value);
  return id !== null && id >= CLASSIC_SKIN_ITEM_ID_MIN && id <= CLASSIC_SKIN_ITEM_ID_MAX;
};

const hasClassicAssetName = (value) => (
  typeof value === 'string' && /(?:^|[/_])jade_[a-z0-9_]+/i.test(value)
);

/** Detect a League Classic skin across the variants returned by Riot's APIs. */
const isLeagueClassicSkin = (skin) => {
  if (!skin || typeof skin !== 'object') return false;

  const championIds = [skin.championId, skin.parentChampionId];
  const skinIds = [skin.id, skin.itemId, skin.skinId, skin.parentItemId];
  if (championIds.some(isClassicChampionId) || skinIds.some(isClassicSkinId)) return true;

  const assetNames = [
    skin.alias,
    skin.contentId,
    skin.inventoryType,
  ];
  return assetNames.some(hasClassicAssetName);
};

/** Return a copy that Collection treats exactly like a skin the player does not own. */
const markLeagueClassicSkinUnowned = (skin) => ({
  ...skin,
  owned: false,
  isOwned: false,
  unlocked: false,
  ownership: {
    ...(skin.ownership ?? {}),
    owned: false,
    rental: {
      ...(typeof skin.ownership?.rental === 'object' ? skin.ownership.rental : {}),
      rented: false,
    },
  },
});

const isAlreadyUnowned = (skin) => (
  skin.owned === false
  && skin.isOwned === false
  && skin.unlocked === false
  && skin.ownership?.owned === false
  && skin.ownership?.rental?.rented === false
);

/**
 * Transform the Map consumed by Collection's Ember controller. Replacing this
 * model value makes its computed filters and virtual-grid measurements update,
 * unlike hiding already-rendered cards with CSS.
 */
const markClassicSkinsMapUnowned = (skinsById) => {
  if (!(skinsById instanceof Map)) return skinsById;

  let changed = false;
  const transformed = new Map();
  for (const [id, skin] of skinsById) {
    if (isLeagueClassicSkin(skin) && !isAlreadyUnowned(skin)) {
      transformed.set(id, markLeagueClassicSkinUnowned(skin));
      changed = true;
    } else {
      transformed.set(id, skin);
    }
  }
  return changed ? transformed : skinsById;
};

const transformValue = (value, forceUnowned = false) => {
  if (Array.isArray(value)) {
    return value.map(entry => transformValue(entry, forceUnowned));
  }
  if (!value || typeof value !== 'object') return value;

  const transformed = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, transformValue(entry, forceUnowned)]),
  );
  return forceUnowned || isLeagueClassicSkin(value)
    ? markLeagueClassicSkinUnowned(transformed)
    : transformed;
};

const classicChampionIdFromUrl = (url) => {
  const match = String(url ?? '').match(/\/champions\/(\d+)\/skins(?:[/?]|$)/i);
  return match ? toInteger(match[1]) : null;
};

/**
 * Transform Collection skin data before Riot computes ownership filters/groups.
 * Inventory-only responses omit unowned entries, so Classic entries are removed
 * there; richer skin responses retain them but report them as unowned.
 */
const transformClassicSkinsPayload = (payload, url = '') => {
  const endpoint = String(url ?? '');
  if (/\/lol-inventory\/v2\/inventory\/CHAMPION_SKIN(?:[/?]|$)/i.test(endpoint)) {
    if (Array.isArray(payload)) return payload.filter(entry => !isLeagueClassicSkin(entry));
    if (Array.isArray(payload?.items)) {
      return { ...payload, items: payload.items.filter(entry => !isLeagueClassicSkin(entry)) };
    }
  }

  const endpointChampionId = classicChampionIdFromUrl(endpoint);
  return transformValue(payload, isClassicChampionId(endpointChampionId));
};


const STATE_KEY = Symbol.for('pengu.hide-league-classic-skins.standalone');
const ENDPOINTS = [
    /\/lol-champions\/v1\/inventories\/[^/?]+\/skins-minimal(?:\?|$)/i,
    /\/lol-champions\/v1\/inventories\/[^/?]+\/skins(?:\?|$)/i,
    /\/lol-champions\/v1\/inventories\/[^/?]+\/champions\/\d+\/skins(?:[/?]|$)/i,
    /\/lol-inventory\/v2\/inventory\/CHAMPION_SKIN(?:\?|$)/i,
];
const shouldFilter = url => ENDPOINTS.some(pattern => pattern.test(String(url ?? '')));
const CONTROLLER_KEYS = [
    'model.skinsById', 'skinsById', 'skins', 'searchedSkins',
    'filteredSkins', 'groupedSkins', 'totalOwned', 'totalOwnedLegacy',
];

const filterFetchResponse = async (response, url) => {
    try {
        const payload = await response.clone().json();
        const filtered = transformClassicSkinsPayload(payload, url);
        if (JSON.stringify(payload) === JSON.stringify(filtered)) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify(filtered), {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    } catch (error) {
        console.error('[Hide Classic Skins] Could not filter fetch response:', error);
        return response;
    }
};

const installNetworkFilter = state => {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0] instanceof Request ? args[0].url : args[0];
        return shouldFilter(url) ? filterFetchResponse(response, url) : response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (state.rewrittenXhrs.has(this)) {
            delete this.responseText;
            delete this.response;
            state.rewrittenXhrs.delete(this);
        }
        state.xhrUrls.set(this, String(url ?? ''));
        return originalOpen.call(this, method, url, ...rest);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
        const url = state.xhrUrls.get(this);
        if (shouldFilter(url)) {
            let completed = false;
            const filterResponse = () => {
                if (this.readyState !== XMLHttpRequest.DONE || completed) return;
                completed = true;
                this.removeEventListener('readystatechange', filterResponse);
                try {
                    const source = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                    const filtered = transformClassicSkinsPayload(source, url);
                    if (JSON.stringify(source) === JSON.stringify(filtered)) return;
                    const serialized = JSON.stringify(filtered);
                    Object.defineProperty(this, 'responseText', { configurable: true, value: serialized });
                    Object.defineProperty(this, 'response', {
                        configurable: true,
                        value: this.responseType === 'json' ? filtered : serialized,
                    });
                    state.rewrittenXhrs.add(this);
                } catch (error) {
                    console.error('[Hide Classic Skins] Could not filter XHR response:', error);
                }
            };
            if (typeof this.onreadystatechange === 'function') {
                const originalHandler = this.onreadystatechange;
                const wrappedHandler = (...eventArgs) => {
                    filterResponse();
                    if (completed && this.onreadystatechange === wrappedHandler) this.onreadystatechange = originalHandler;
                    return originalHandler.apply(this, eventArgs);
                };
                this.onreadystatechange = wrappedHandler;
            }
            this.addEventListener('readystatechange', filterResponse);
        }
        return originalSend.apply(this, args);
    };
};

const filterCollectionModel = async state => {
    if (state.applyingModel) return false;
    state.applyingModel = true;
    try {
        const controller = state.collectionApi?._applicationInstance?.lookup?.('controller:skins');
        const model = controller?.get?.('model');
        const source = model?.skinsById;
        if (!(source instanceof Map)) return false;
        const transformed = markClassicSkinsMapUnowned(source);
        if (transformed === source) return false;
        const ember = await state.emberApi?.getEmber?.();
        if (!ember || model.skinsById !== source) return false;
        ember.set(model, 'skinsById', transformed);
        for (const key of CONTROLLER_KEYS) controller.notifyPropertyChange(key);
        return true;
    } catch (error) {
        console.error('[Hide Classic Skins] Could not update the Collection model:', error);
        return false;
    } finally {
        state.applyingModel = false;
    }
};

export function init(context) {
    if (window[STATE_KEY]) return;
    const state = {
        xhrUrls: new WeakMap(),
        rewrittenXhrs: new WeakSet(),
        applyingModel: false,
    };
    window[STATE_KEY] = state;
    installNetworkFilter(state);
    context.rcp.postInit('rcp-fe-ember-libs', api => {
        state.emberApi = api;
        void filterCollectionModel(state);
    });
    context.rcp.postInit('rcp-fe-lol-collections', api => {
        state.collectionApi = api;
        const apply = () => filterCollectionModel(state);
        void apply();
        state.collectionTimer ??= setInterval(apply, 500);
    });
}
