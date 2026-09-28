#!/usr/bin/env node
/**
 * 离线计算 Cubism 模型的内容包围盒（content）——无需浏览器/WebGL。
 *
 * 加载官方 Cubism core（纯 WASM 计算）解析 moc3 的 drawable 顶点，
 * 输出画布像素坐标系（原点左上、y 向下）下的内容包围盒。
 * 把结果写进 models.json 对应模型的 content 字段，运行时即可
 * 免顶点遍历一次平移定位（贴底贴左）；缺 content 的模型会被拒绝加载。
 *
 * 用法：
 *   npm run build        # 先确保 dist/vendor/live2dcubismcore.min.js 就位
 *   node scripts/calc-content-box.mjs <模型1>.moc3 [<模型2>.moc3 ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.join(here, '../dist/vendor/live2dcubismcore.min.js');

// core 是 Emscripten 产物：CJS 环境下命名空间不导出、WASM 异步初始化，
// 因此用 vm 在全局作用域执行源码（var Live2DCubismCore 落到全局）并轮询就绪。
global.__dirname = path.dirname(corePath);
global.__filename = corePath;
vm.runInThisContext(fs.readFileSync(corePath, 'utf8'), { filename: corePath });

async function waitCore(ns) {
	for (let i = 0; i < 300; i++) {
		try {
			ns.Moc.fromArrayBuffer(new ArrayBuffer(16));
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	throw new Error('Cubism core WASM 未就绪');
}

function calcBox(mocPath) {
	const buf = fs.readFileSync(mocPath);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const moc = Live2DCubismCore.Moc.fromArrayBuffer(ab);
	if (!moc) throw new Error(`Moc.fromArrayBuffer failed: ${mocPath}`);
	const model = Live2DCubismCore.Model.fromMoc(moc);
	if (!model) throw new Error(`Model.fromMoc failed: ${mocPath}`);
	const ci = model.canvasinfo; // { PixelsPerUnit, CanvasWidth(px), CanvasHeight(px) }
	const d = model.drawables; // count / vertexCounts[] / vertexPositions[]（每 drawable 一个平铺 [x,y,...] 数组，逻辑坐标）
	const W = ci.CanvasWidth;
	const H = ci.CanvasHeight;
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	const skipped = [];
	for (let i = 0; i < d.count; i++) {
		const v = d.vertexPositions[i];
		let dMinX = Infinity, dMaxX = -Infinity, dMinY = Infinity, dMaxY = -Infinity;
		for (let j = 0; j < v.length; j += 2) {
			const x = v[j] * ci.PixelsPerUnit + W / 2;
			const y = -v[j + 1] * ci.PixelsPerUnit + H / 2; // 逻辑 y 向上，翻转为画布 y 向下
			if (x < dMinX) dMinX = x;
			if (x > dMaxX) dMaxX = x;
			if (y < dMinY) dMinY = y;
			if (y > dMaxY) dMaxY = y;
		}
		// 排除"不可见的大跨度网格"：顶点数极少（<=8）却横跨大半画布，且默认 opacity=0。
		// 这类网格是背景色块/遮罩（如 bg 表情用的全幅矩形），渲染时不可见，
		// 但会把包围盒撑到画布边缘，导致定位与气泡锚定产生几十像素偏差。
		const spanX = dMaxX - dMinX;
		const spanY = dMaxY - dMinY;
		if (d.vertexCounts[i] <= 8 && (spanX > W * 0.6 || spanY > H * 0.6) && d.opacities[i] === 0) {
			skipped.push({ id: d.ids[i], pts: d.vertexCounts[i], span: `${Math.round(spanX)}x${Math.round(spanY)}` });
			continue;
		}
		if (dMinX < minX) minX = dMinX;
		if (dMaxX > maxX) maxX = dMaxX;
		if (dMinY < minY) minY = dMinY;
		if (dMaxY > maxY) maxY = dMaxY;
	}
	if (minX === Infinity) throw new Error(`no drawables: ${mocPath}`);
	return {
		id: path.basename(mocPath, '.moc3'),
		content: { minX: Math.round(minX), minY: Math.round(minY), maxX: Math.round(maxX), maxY: Math.round(maxY) },
		canvas: [W, H],
		pixelsPerUnit: ci.PixelsPerUnit,
		skippedInvisibleGrids: skipped,
	};
}

(async () => {
	await waitCore(Live2DCubismCore);
	for (const p of process.argv.slice(2)) {
		console.log(JSON.stringify(calcBox(p)));
	}
})();
