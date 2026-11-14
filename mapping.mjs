export function findBinding(bindings, profiles, name) {
    return profiles.find(p => p.id === bindings[name] && p.mode === 'cc');
}

export function bindProfile(bindings, profiles, name, id) {
    if (!name) throw new Error('请先选择预设。');
    if (!id) {
        delete bindings[name];
        return null;
    }
    const profile = profiles.find(p => p.id === id && p.mode === 'cc');
    if (!profile) throw new Error('连接配置不存在，请重新选择。');
    if (Object.entries(bindings).some(([n, value]) => n !== name && value === id)) {
        throw new Error('此连接已对应另一预设，请先为它复制一套连接配置。');
    }
    bindings[name] = id;
    profile.preset = name;
    return profile;
}
