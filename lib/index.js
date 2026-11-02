/**
 * 宿主半边：只有一个浏览器侧的小面板，宿主这里不需要任何能力。
 * cordis loader 按 patch 行的 name 加载本包，要求导出 name + apply。
 */
export const name = 'dsh-custom-profile'

/** 无宿主能力。 */
export function apply() {}
