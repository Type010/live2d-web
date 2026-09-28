/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppGlManager } from './lappglmanager';

/**
 * テクスチャ管理クラス
 * 画像読み込み、管理を行うクラス。
 */
export class LAppTextureManager {
  /**
   * コンストラクタ
   */
  public constructor() {
    this._textures = new Array<TextureInfo>();
  }

  /**
   * 解放する。
   */
  public release(): void {
    for (let i = 0; i < this._textures.length; i++) {
      this._glManager.getGl().deleteTexture(this._textures[i].id);
    }
    this._textures = null;
  }

  /**
   * 画像読み込み
   *
   * @param fileName 読み込む画像ファイルパス名
   * @param usePremultiply Premult処理を有効にするか
   * @return 画像情報、読み込み失敗時はnullを返す
   */
  public createTextureFromPngFile(
    fileName: string,
    usePremultiply: boolean,
    callback: (textureInfo: TextureInfo) => void
  ): void {
    // search loaded texture already
    for (let i = 0; i < this._textures.length; i++) {
      if (
        this._textures[i].fileName == fileName &&
        this._textures[i].usePremultply == usePremultiply
      ) {
        // 2回目以降はキャッシュが使用される(待ち時間なし)
        // waifu-web: 复用即刷新最近使用时刻，LRU 才不会淘汰当前模型在用的贴图
        this._textures[i].lastUsed = performance.now();
        // WebKitでは同じImageのonloadを再度呼ぶには再インスタンスが必要
        // 詳細：https://stackoverflow.com/a/5024181
        this._textures[i].img = new Image();
        // 本地补丁：贴图可能来自与宿主页不同源的模型库，未声明 CORS 时 WebGL 会拒绝 texImage2D
        this._textures[i].img.crossOrigin = 'anonymous';
        this._textures[i].img.addEventListener(
          'load',
          (): void => callback(this._textures[i]),
          {
            passive: true
          }
        );
        this._textures[i].img.src = fileName;
        return;
      }
    }

    // データのオンロードをトリガーにする
    const img = new Image();
    // 本地补丁：同上，跨域模型库的贴图必须走 CORS 才能上载到 WebGL
    img.crossOrigin = 'anonymous';
    img.addEventListener(
      'load',
      (): void => {
        // テクスチャオブジェクトの作成
        const tex: WebGLTexture = this._glManager.getGl().createTexture();

        // テクスチャを選択
        this._glManager
          .getGl()
          .bindTexture(this._glManager.getGl().TEXTURE_2D, tex);

        // テクスチャにピクセルを書き込む
        this._glManager
          .getGl()
          .texParameteri(
            this._glManager.getGl().TEXTURE_2D,
            this._glManager.getGl().TEXTURE_MIN_FILTER,
            this._glManager.getGl().LINEAR_MIPMAP_LINEAR
          );
        this._glManager
          .getGl()
          .texParameteri(
            this._glManager.getGl().TEXTURE_2D,
            this._glManager.getGl().TEXTURE_MAG_FILTER,
            this._glManager.getGl().LINEAR
          );

        // Premult処理を行わせる
        if (usePremultiply) {
          this._glManager
            .getGl()
            .pixelStorei(
              this._glManager.getGl().UNPACK_PREMULTIPLY_ALPHA_WEBGL,
              1
            );
        }

        // テクスチャにピクセルを書き込む
        this._glManager
          .getGl()
          .texImage2D(
            this._glManager.getGl().TEXTURE_2D,
            0,
            this._glManager.getGl().RGBA,
            this._glManager.getGl().RGBA,
            this._glManager.getGl().UNSIGNED_BYTE,
            img
          );

        // ミップマップを生成
        this._glManager
          .getGl()
          .generateMipmap(this._glManager.getGl().TEXTURE_2D);

        // テクスチャをバインド
        this._glManager
          .getGl()
          .bindTexture(this._glManager.getGl().TEXTURE_2D, null);

        const textureInfo: TextureInfo = new TextureInfo();
        if (textureInfo != null) {
          textureInfo.fileName = fileName;
          textureInfo.width = img.width;
          textureInfo.height = img.height;
          textureInfo.id = tex;
          textureInfo.img = img;
          textureInfo.usePremultply = usePremultiply;
          textureInfo.lastUsed = performance.now();
          if (this._textures != null) {
            this._textures.push(textureInfo);
            this.evictLeastRecentlyUsed();
          }
        }

        callback(textureInfo);
      },
      { passive: true }
    );
    img.src = fileName;
  }

  /**
   * 缓存上限与 LRU 淘汰（waifu-web 本地补丁）。
   *
   * 贴图按文件名缓存以便跨模型复用（切回去不用重下），但缓存原本没有上限：
   * 长时间会话切过多个模型后，4K 贴图（解码后每张约 64MB）会一直累积，
   * 而 GL 纹理只能靠上下文回收。这里在超过上限时释放最久未使用的——
   * 当前模型的贴图在加载时刚被 touch，最近使用时刻必然最新，因此不会被误淘汰。
   */
  private evictLeastRecentlyUsed(): void {
    while (this._textures.length > LAppTextureManager.MaxCachedTextures) {
      let oldest = 0;
      for (let i = 1; i < this._textures.length; i++) {
        if (this._textures[i].lastUsed < this._textures[oldest].lastUsed) {
          oldest = i;
        }
      }
      const victim = this._textures[oldest];
      if (victim.id) {
        this._glManager.getGl().deleteTexture(victim.id);
      }
      this._textures.splice(oldest, 1);
    }
  }

  /**
   * 画像の解放
   *
   * 配列に存在する画像全てを解放する。
   */
  public releaseTextures(): void {
    for (let i = 0; i < this._textures.length; i++) {
      this._glManager.getGl().deleteTexture(this._textures[i].id);
      this._textures[i] = null;
    }

    this._textures.length = 0;
  }

  /**
   * 画像の解放
   *
   * 指定したテクスチャの画像を解放する。
   * @param texture 解放するテクスチャ
   */
  public releaseTextureByTexture(texture: WebGLTexture): void {
    for (let i = 0; i < this._textures.length; i++) {
      if (this._textures[i].id != texture) {
        continue;
      }

      this._glManager.getGl().deleteTexture(this._textures[i].id);
      this._textures[i] = null;
      this._textures.splice(i, 1);
      break;
    }
  }

  /**
   * 画像の解放
   *
   * 指定した名前の画像を解放する。
   * @param fileName 解放する画像ファイルパス名
   */
  public releaseTextureByFilePath(fileName: string): void {
    for (let i = 0; i < this._textures.length; i++) {
      if (this._textures[i].fileName == fileName) {
        this._glManager.getGl().deleteTexture(this._textures[i].id);
        this._textures[i] = null;
        this._textures.splice(i, 1);
        break;
      }
    }
  }

  /**
   * setter
   * @param glManager
   */
  public setGlManager(glManager: LAppGlManager): void {
    this._glManager = glManager;
  }

  _textures: Array<TextureInfo>;
  private _glManager: LAppGlManager;
  // waifu-web: 贴图缓存条数上限。取值覆盖"两三个模型同时在缓存里"的常见场景
  // （小恶魔 5 张 + 小天使 19 张），超出后按 LRU 淘汰。
  private static readonly MaxCachedTextures = 40;
}

/**
 * 画像情報構造体
 */
export class TextureInfo {
  img: HTMLImageElement; // 画像
  id: WebGLTexture = null; // テクスチャ
  width = 0; // 横幅
  height = 0; // 高さ
  usePremultply: boolean; // Premult処理を有効にするか
  fileName: string; // ファイル名
  lastUsed = 0; // waifu-web: 最終使用時刻（LRU 淘汰用）
}
