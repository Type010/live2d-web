/**
 * 渲染引擎 chunk 入口：官方 Cubism SDK 5 相关的一切（framework + 示例适配层）都在这里，
 * 与主 bundle 分离的原因有两个：
 *   1) 框架在模块求值期就会读 Live2DCubismCore（ColorBlendType 枚举），必须等内核先加载；
 *   2) 门槛不通过的设备（窄屏 / 减弱动效 / 无 WebGL2）不必下载这两百多 KB。
 * 主 bundle 通过 window.WaifuEngine.createEngine(config) 拿到引擎实例。
 */
import { Engine } from './engine.js';

window.WaifuEngine = {
	createEngine: (config) => new Engine(config),
};
