/**
 * @fileoverview Vite 构建工具配置文件
 * @description 配置开发服务器、生产构建选项和插件。
 *
 * 构建策略：
 *   - 代码分包（manualChunks）将 three.js、React Three Fiber 和 React 分离到独立 chunk，
 *     利用浏览器缓存机制：当仅修改游戏逻辑时，three.js chunk 无需重新下载
 *   - target='esnext' 输出 ES 模块语法，免去 polyfill 开销，适配现代浏览器
 *   - base='./' 使用相对路径，确保 dist 目录被 gamesvr 静态文件服务器托管时资源路径正确
 *
 * 开发服务器配置：
 *   - usePolling=true：Windows/WSL 环境下 inotify 事件不可靠，轮询保证文件变更检测
 *   - hmr.overlay=true：编译错误在浏览器中以覆盖层形式显示，无需切换终端查看
 *
 * @author WildMap Team
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  /**
   * 相对路径基准（重要）：
   * 设为 './' 而非 '/'，确保 gamesvr 将 client/dist 挂载到任意路径时资源加载正常。
   * 若设为 '/'，当 gamesvr 将静态资源托管在子路径下时，绝对路径会导致 404。
   */
  base: './',

  server: {
    port: 3000,
    host: true,
    watch: {
      /**
       * 轮询模式文件监听
       * 原因：Windows 和 WSL2 环境下 Node.js 的 fs.watch 基于 inotify，
       * 在某些文件系统（NTFS 跨 WSL 挂载）下无法可靠触发变更事件。
       * interval=300ms 是实时性与 CPU 占用的折中值（100ms 以下 CPU 明显升高）。
       */
      usePolling: true,
      interval: 300,
    },
    hmr: {
      overlay: true,
    },
  },

  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        /**
         * 手动代码分包策略
         * 将重型依赖分离到独立 chunk，实现最优缓存利用：
         *   - three：Three.js 核心库（约 650KB gzip），极少更新
         *   - react-three：R3F + Drei，随游戏功能更新而变化
         *   - react：React + ReactDOM，框架层，几乎不变
         * 业务代码（src/）单独打包，修改时仅使业务 chunk 缓存失效。
         */
        manualChunks: {
          three: ['three'],
          'react-three': ['@react-three/fiber', '@react-three/drei'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
