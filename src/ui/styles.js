/**
 * 看板娘 UI 样式，全部带 waifu- 前缀并注入独立 <style>，不污染宿主站点。
 */
export function injectStyles() {
	if (document.getElementById('waifu-web-style')) return;
	const style = document.createElement('style');
	style.id = 'waifu-web-style';
	style.textContent = `
#waifu-web .waifu-toolbar{position:absolute;top:16px;display:flex;flex-direction:column;gap:8px;opacity:0;pointer-events:none;transform:translateX(-12px);transition:opacity .2s ease,transform .2s ease}
#waifu-web.waifu-tb-show .waifu-toolbar{opacity:1;pointer-events:auto;transform:translateX(0)}
#waifu-web .waifu-btn{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;border:1px solid #ffd3dc;background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer;padding:0;color:#c58f9c;transition:transform .15s ease}
#waifu-web .waifu-btn:hover{transform:scale(1.12)}
#waifu-web .waifu-btn svg{width:16px;height:16px;display:block}
#waifu-web .waifu-bubble{position:absolute;left:50%;bottom:calc(100% + 12px);max-width:240px;padding:10px 14px;border-radius:12px;border:1px solid #ffd3dc;background:#fffbeff2;color:#7a4b57;font-size:14px;line-height:1.5;box-shadow:0 3px 12px rgba(0,0,0,.1);opacity:0;transform:translate(-50%,6px);transition:opacity .25s ease,transform .25s ease;pointer-events:none;word-break:break-word}
#waifu-web .waifu-bubble.show{opacity:1;transform:translate(-50%,0)}
#waifu-web .waifu-panel{position:absolute;width:230px;max-height:420px;overflow-y:auto;overscroll-behavior:contain;border-radius:12px;border:1px solid #ffd3dc;background:rgba(255,255,255,.96);box-shadow:0 6px 20px rgba(0,0,0,.14);padding:10px;display:none}
#waifu-web .waifu-panel.show{display:block;pointer-events:auto}
#waifu-web .waifu-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
#waifu-web .waifu-panel-head span{font-size:13px;font-weight:600;color:#c58f9c}
#waifu-web .waifu-panel-close{width:22px;height:22px;border-radius:50%;border:1px solid #ffd3dc;background:#fff;color:#c58f9c;font-size:12px;line-height:1;cursor:pointer;padding:0}
#waifu-web .waifu-panel-close:hover{background:#fff0f4}
#waifu-web .waifu-panel h4{margin:8px 0 6px;font-size:12px;color:#c58f9c;font-weight:600}
#waifu-web .waifu-panel h4:first-of-type{margin-top:0}
#waifu-web .waifu-exp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
#waifu-web .waifu-exp{padding:6px 4px;border-radius:8px;border:1px solid #ffd3dc;background:#fff;font-size:12px;color:#7a4b57;cursor:pointer;text-align:center}
#waifu-web .waifu-exp:hover{background:#fff0f4}
#waifu-web .waifu-exp.on{background:#ffb6c1;color:#fff;border-color:#ff9db1}
#waifu-web .waifu-settings{width:250px}
#waifu-web .waifu-row{display:flex;align-items:center;gap:8px;margin:7px 0}
#waifu-web .waifu-row label{flex:none;width:74px;font-size:12px;color:#7a4b57}
#waifu-web .waifu-row input[type=range]{flex:1;min-width:0;height:16px;accent-color:#ff9db1}
#waifu-web .waifu-choices{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px}
#waifu-web .waifu-choice{padding:2px 8px;border-radius:8px;border:1px solid #ffd3dc;background:#fff;color:#7a4b57;font-size:11px;cursor:pointer;line-height:1.6}
#waifu-web .waifu-choice:hover{background:#fff0f4}
#waifu-web .waifu-choice.on{background:#ffb6c1;color:#fff;border-color:#ff9db1}
#waifu-web .waifu-row .val{flex:none;width:38px;text-align:right;font-size:11px;color:#c58f9c;font-variant-numeric:tabular-nums}
#waifu-web .waifu-hint{margin:2px 0 8px;font-size:11px;color:#c0a3ab;line-height:1.5}
#waifu-web .waifu-settings-foot{display:flex;justify-content:flex-end;margin-top:8px}
#waifu-web .waifu-settings-foot button{padding:4px 10px;border-radius:8px;border:1px solid #ffd3dc;background:#fff;color:#7a4b57;font-size:12px;cursor:pointer}
#waifu-web .waifu-settings-foot button:hover{background:#fff0f4}
`;
	document.head.appendChild(style);
}
