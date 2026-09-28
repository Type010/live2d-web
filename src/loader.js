/**
 * 环境探测与资源加载。
 * 运行时只有两件：官方 Cubism 内核（live2dcubismcore.min.js）与渲染引擎 chunk
 * （engine.js，官方框架 + 适配层打包），前者必须先就位——框架在模块求值期就会读它；
 * 加载失败抛错由入口统一静默降级，绝不影响宿主页面。
 */

const loadedScripts = new Map();

export function loadScript(src) {
	if (loadedScripts.has(src)) return loadedScripts.get(src);
	const p = new Promise((resolve, reject) => {
		const tag = document.createElement('script');
		tag.src = src;
		tag.onload = () => resolve(src);
		tag.onerror = () => {
			loadedScripts.delete(src);
			reject(new Error(`[waifu] 加载失败: ${src}`));
		};
		document.head.appendChild(tag);
	});
	loadedScripts.set(src, p);
	return p;
}

/** 环境门槛：桌面宽度、未被用户关闭、WebGL 可用 */
export function canRun(config) {
	if (window.innerWidth < config.minWidth) return false;
	if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		// 尊重减弱动效偏好：跳过看板娘
		return false;
	}
	try {
		const c = document.createElement('canvas');
		// 官方 Cubism SDK 5 的渲染器要求 WebGL2，门槛随之提高
		if (!c.getContext('webgl2')) return false;
	} catch {
		return false;
	}
	return true;
}

/**
 * 拉取并解析 JSON。
 * bust=true 用于清单这类"必须每次拿最新"的文件（URL 加时间戳形成独立缓存键，
 * 绕开浏览器强缓存与 CDN 边缘缓存）；表情定义等静态资源用默认缓存策略。
 */
export function fetchJSON(url, bust = false) {
	const target = bust ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
	return fetch(target).then((r) => {
		if (!r.ok) throw new Error(`[waifu] 请求失败 ${r.status}: ${url}`);
		return r.json();
	});
}

/**
 * 加载运行时：只需要官方 Cubism 内核（live2dcubismcore.min.js）。
 * 渲染与模型调度由 bundle 内置的官方 CubismWebFramework 5 + 适配层承担。
 * 图标为内联 SVG（ui/icons.js），随 bundle 一起走，不再有额外样式表请求。
 */
export async function loadRuntime(config) {
	const vendor = config.vendorUrl;
	if (window.Live2DCubismCore) return;
	await loadScript(config.coreUrl || `${vendor}live2dcubismcore.min.js`);
	if (!window.Live2DCubismCore) throw new Error('[waifu] Cubism 内核加载失败');
}
