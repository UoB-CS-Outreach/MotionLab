const loadedScripts = new Map();

// Loads a classic (non-module) script once per page and resolves when it has run.
export function loadScript(url) {
    if (loadedScripts.has(url)) return loadedScripts.get(url);
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
            loadedScripts.delete(url);
            script.remove();
            reject(new Error(`Could not load ${new URL(url).hostname}`));
        };
        document.head.appendChild(script);
    });
    loadedScripts.set(url, promise);
    return promise;
}

export function withTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function randomToken(length = 8) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => alphabet[byte % 32]).join("");
}
