// MoonChatBot 控制台 —— 桌面壳
//
// 这是一个「薄壳」：只负责把面板前端装进一个独立窗口，
// 真正的后端服务（QQ 机器人 + 记忆 + API）仍由 node server.js 独立运行。
//
// 壳与服务是解耦的：
//   服务：http://127.0.0.1:4357（本机常驻，含 Playwright、机器人长连接）
//   壳　：加载内嵌的前端资源（源自身 tauri.localhost），跨域调上面的 API
// 服务端已在 createServer 里放行 tauri.localhost 系列 origin 的 CORS。

// Windows 发布版不要弹出那个黑色控制台窗口。
// 注意只在非 debug 下生效 —— 开发时要留着它看 panic 信息。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}