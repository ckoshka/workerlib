import { expose } from "./mod.ts";

let worker = {
    loadModuleFromPath: async (moduleName) => {
        const mod = await import(moduleName);
        worker = mod;
        expose(mod)(self);
    }
}

expose(worker)(self);

