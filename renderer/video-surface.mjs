// DEV 试用：把录制模块装进“已经可见的指示条”这一扇窗（同一 webContents）。
// 这里只注册 globalThis.startVideoRecording，不开录；只有用户点「开始录制」后，
// 主进程才用可信手势调用它。隐藏录制窗 + 独立指示条的老路径一点没动。
import './video-recorder.mjs';
