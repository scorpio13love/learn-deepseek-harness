# 课程网站

`site/` 是随仓库开源的网站源码（不是生成物）。clone 后不需要构建、不需要安装前端依赖，运行一个本地静态服务器即可搭配课程学习。

18 课的可浏览版本：首页课程地图、侧边课节目录、讲义阅读页、页内目录、学习进度、搜索、深浅色主题。

![课程首页](../docs/assets/course-home.png)

## 打开方式

```sh
git clone <this-repo>
cd learn-deepseek-harness

node site/serve.mjs
# http://127.0.0.1:4173/site/
```

服务器以仓库根目录为根，因此站点会直接读取：

- `course/lessons/<slug>/README.md`
- `docs/00-architecture.zh.md`
- `docs/01-course-design.zh.md`
- `course/README.md`

**不要直接双击 `site/index.html`**：浏览器在 `file://` 下禁止 `fetch` 同级 Markdown，页面无法加载讲义。站点必须通过本地服务器或静态托管访问。

## 目录

```text
site/
  index.html          站点外壳
  styles.css          版式 / 主题 / 响应式
  app.js              路由、Markdown 渲染、进度、搜索、TOC
  data.js             18 课与文档元数据
  serve.mjs           零依赖静态服务器
```

没有 `content/`、`content.js`、`docs/` 或截图副本：讲义正文只有一个来源，即 `course/lessons/*/README.md` 与 `docs/*.md`。

## 更新课程内容

直接编辑源 Markdown，然后刷新页面即可：

- 课程：`course/lessons/*/README.md`
- 架构笔记：`docs/00-architecture.zh.md`
- 课程设计：`docs/01-course-design.zh.md`
- 课程工程：`course/README.md`
- 课程标题、摘要、难度、标签、源码锚点：`site/data.js`

## 功能

- Hash 路由：`#/s01-agent-loop`、`#/docs/architecture`，可直接分享；
- 学习进度：localStorage 记录，侧边栏勾选 + 首页进度；
- 搜索：按标题、简短描述、标签过滤；
- 页内目录：h2/h3 自动生成，滚动高亮；
- 代码块：语言标签 + 一键复制；
- 文档阅读：架构笔记、课程设计、课程工程说明复用讲义渲染；
- 旧文档地址：`/docs/00-architecture.zh.md` 在浏览器中 302 到 `#/docs/architecture`，加 `?raw=1` 可看原文；
- 源码链接：DSH 源码指向 GitHub，课程源码指向本地 `course/lessons/<slug>/`；
- 快捷键：`[` / `]` 上一课 / 下一课，`Esc` 关闭移动端目录；
- 深浅色：跟随系统，可手动切换并记住。

## 设计取舍

- 零运行时依赖：Markdown 渲染器是手写的子集，覆盖标题、段落、列表、表格、引用、行内代码、代码块与链接；
- 单一来源：不在仓库里放讲义副本、内联 bundle 或构建产物；
- 不使用前端框架：站点本身也是「可读的 mini 实现」，方便课程读者修改。

## 部署

站点需要能同时访问 `/site/`、`/course/`、`/docs/`。如果使用 GitHub Pages，请把发布目录设为**仓库根目录**，然后访问 `/site/`；不要只发布 `site/` 子目录，否则讲义 Markdown 不在同一站点根下。

## License

课程代码、讲义与网站采用 [MIT License](../LICENSE)。上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 也是 MIT，版权与许可见 [`LICENSE-UPSTREAM`](../LICENSE-UPSTREAM) 与 [`NOTICE`](../NOTICE)；本项目是独立的学习用重写，不代表上游。
