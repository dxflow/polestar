import { CyclicDependencyError, UnresolvableError } from './Errors'
import { Resolver, ResolutionType, Resolution } from './Resolver'
import { DefaultResolver } from './DefaultResolver'
import { VersionRanges } from './VersionRanges'
import { Fetcher, FetchResult } from './Fetcher'
import { createFunction } from './createFunction'

interface AMDDefineFunction {
  (name: string | string[] | Function, dependencies?: string[] | Function, factory?: Function): void;
  amd?: true
}

export function createPolestar(options: PolestarOptions = {}) {
  return new Polestar(options)
}

export interface PolestarOptions {
  // fetches a given URL, returning enough info for the loader to load it
  fetcher?: Fetcher

  // handles resolution of require statements to module ids or URLs to load
  // ids from
  resolver?: Resolver,

  /**
   * Each key in this object will be injected as a global in the module, allowing
   * you to supply overrides for `window`, `history`, `global`, etc.
   */
  globals?: object

  /**
   * The object that will be available under `this` within the module.
   */
  moduleThis?: any

  /**
   * If supplied, this will be called when the first entry point module
   * is executed.
   */
  onEntry?: () => void

  /**
   * Will be called with each unique error that is encountered. Once this has
   * been called, any in-progress loads will be halted.
   */
  onError?: (error) => void
}

export class Polestar {
  private loads: {
    [url: string]: {
      requiredBy: ModuleWrapper[]
      preparedModuleWrapperPromise: Promise<ModuleWrapper>
    }
  }
  private resolver: Resolver
  private error?: any
  private errorDetail?: { errorModuleId: string }
  private hasCalledOnEntry = false
  private nextEntryId = 1

  options: PolestarOptions
  
  moduleWrappers: {
    [id: string]: ModuleWrapper
  }

  constructor(options: PolestarOptions) {
    this.options = Object.assign({ globals: {}, onEntry: () => {} }, options)
    this.loads = {}
    this.moduleWrappers = {}
    this.resolver = options.resolver || new DefaultResolver()
  }

  evaluate(dependencies: string[], code: string, dependencyVersionRanges?: VersionRanges, id?: string): Promise<Module> {
    if (id === undefined) {
      id = 'polestar-anonymous://'+String(this.nextEntryId++)
    }

    return this.prepareModuleWrapper(
      id,
      code,
      dependencies || [],
      dependencyVersionRanges || {}
    ).then(getModule)
  }

  require(request: string): Promise<Module> {
    let resolution = this.resolve(request)
    let url = resolution.type === ResolutionType.Available ? resolution.id : resolution.url
    let modulePromise = this.loadWrapper(url).then(getModule)
    modulePromise.catch(this.setError)
    return modulePromise
  }

  resolve(request: string, parentId?: string, defaultPackageVersionRanges: VersionRanges = {}): Resolution {
    return this.resolver.resolve(request, parentId, defaultPackageVersionRanges)
  }

  // Initializes a module if it doesn't already exist
  loadWrapper(url: string, requiredBy?: ModuleWrapper, originalRequest?: string): Promise<ModuleWrapper> {
    let moduleWrapper = this.moduleWrappers[url]
    if (moduleWrapper) {
      return Promise.resolve(moduleWrapper)
    }

    let existingLoad = this.loads[url]
    if (existingLoad) {
      if (requiredBy) {
        existingLoad.requiredBy.push(requiredBy)
      }
      return existingLoad.preparedModuleWrapperPromise
    }

    let preparedModuleWrapperPromise =
      this.options.fetcher(url, {
        requiredById: requiredBy && requiredBy.module.id,
        originalRequest,
      })
        .then(this.handleFetchResult)

    this.loads[url] = {
      requiredBy: requiredBy ? [requiredBy] : [],
      preparedModuleWrapperPromise,
    }

    return preparedModuleWrapperPromise
  }

  async unload(id: string) {
    const modulesToUnload = new Set([id]);
    let startModuleWrapper = this.moduleWrappers[id];
    // recursively find ids to unload
    const prepareUnloadModuleWrapper = (moduleWrapper: ModuleWrapper) => {
      // try to find from load
      // NOTE if there's an error moduleWrapper could be null
      if (moduleWrapper) {
        moduleWrapper.requiredBy.forEach(requiredModule => {
          const requiredModuleId = requiredModule.module.id;
          if (!modulesToUnload.has(requiredModuleId)) {
            modulesToUnload.add(requiredModuleId);
            prepareUnloadModuleWrapper(requiredModule);
          }
        });
      }
    };
    prepareUnloadModuleWrapper(startModuleWrapper);

    Object.keys(this.loads).forEach(async url => {
      try {
        let preparedModule = await this.loads[url].preparedModuleWrapperPromise;
        if (modulesToUnload.has(preparedModule.module.id)) {
          delete this.loads[url];
        }
      } catch(error) {}
    });

    Object.keys(this.moduleWrappers).forEach(id => {
      if (modulesToUnload.has(id)) {
        delete this.moduleWrappers[id];
      }
    });
    
    if (this.resolver instanceof DefaultResolver) {
      const knownURLs = (this.resolver as DefaultResolver).knownURLs;
      Object.keys(knownURLs).forEach(url => {
        if(modulesToUnload.has(knownURLs[url])) {
          delete knownURLs[url];
        }
      });
    }
  }

  async clearError() {
    if (this.error) {
      this.error = null;

      await Promise.all(Object.keys(this.loads).map(url => {
        if (this.loads[url].preparedModuleWrapperPromise) {
          return this.loads[url].preparedModuleWrapperPromise.catch(error => {
            delete this.loads[url];
          });
        }
        return Promise.resolve();
      }));

      const moduleIds = new Set();
      await Promise.all(Object.keys(this.moduleWrappers).map(id => {
        if (this.moduleWrappers[id].preparedPromise) {
          return this.moduleWrappers[id].preparedPromise.catch(error => {
            moduleIds.add(id);
            delete this.moduleWrappers[id];
          });
        }
        return Promise.resolve();
      }));

      if (this.resolver instanceof DefaultResolver) {
        const knownURLs = (this.resolver as DefaultResolver).knownURLs;
        Object.keys(knownURLs).forEach(url => {
          if (moduleIds.has(knownURLs[url])) {
            delete knownURLs[url];
          }
        });
      }
    }
  }

  private handleFetchResult = (result: FetchResult): Promise<ModuleWrapper> => {
    if (this.error) {
      return Promise.reject(this.error)
    }

    let url = result.url
    let id = result.id
    let load = this.loads[url]

    this.resolver.registerResolvedURL(url, id)

    // It's possible that this id has already been loaded using a different url.
    // If so, we need to let it know of any more requesting modules, in case
    // they're needed to avoid deadlock.
    let moduleWrapper = this.moduleWrappers[id]
    if (moduleWrapper) {
      moduleWrapper.addToRequiredBy(load.requiredBy)
      return Promise.resolve(moduleWrapper)
    }

    return this.prepareModuleWrapper(
      id,
      result.code,
      result.dependencies || [],
      result.dependencyVersionRanges || {},
      load.requiredBy,
      result.css,
    )
  }

  /**
   * Preload modules and cache before evaluate.
   * @param id id you want to preload, ex. 'npm://react'
   * @param preloadedModule preloaded module, ex. React
   * @param css css code
   */
  preloadModule(
    id: string,
    preloadedModule: any,
    css?: string) {
    return this.prepareModuleWrapper(
      id,
      '',
      [],
      undefined,
      [],
      css,
      true,
      preloadedModule
    );
  }

  private prepareModuleWrapper(
    id: string,
    code: string,
    dependencies?: 'umd' | string[],
    dependencyVersionRanges?: VersionRanges,
    requiredBy: ModuleWrapper[] = [], 
    css?: string,
    isPreloadModule?: boolean,
    preloadedModule?: any,
  ): Promise<ModuleWrapper> {
    if (this.error) {
      return Promise.reject(this.error)
    }

    if (css) {
      let style = document.getElementById(id) as HTMLStyleElement;
      if (style && style.dataset.polestarStyleNode) {
        while (style.firstChild) {
          style.removeChild(style.firstChild)
        }
      } else {
        style = document.createElement('style')
        style.type = 'text/css'
        style.dataset.polestarStyleNode = 'true';
        style.id = id
        let head = document.head || document.getElementsByTagName('head')[0]
        head.appendChild(style)
      }
      style.appendChild(document.createTextNode(css))
    }

    try {
      let moduleWrapper: ModuleWrapper | undefined
      let globals = this.options.globals || {}
      let globalNames = Object.keys(globals)
      let globalValues = []
      for (let i = 0; i < globalNames.length; i++) {
        globalValues.push(globals[globalNames[i]])
      }

      let prepareDependencies: string[]

      // For UMD modules, we'll use their dependencies instead of data.prepareRequires.
      if (dependencies === 'umd') {
        const define: AMDDefineFunction = (name, dependencies, factory) => {
          // name and dependencies are optional
          if (!factory) {
            factory = dependencies as Function
            dependencies = Array.isArray(name) ? name : []
            if (dependencies === name) {
            }
            if (!factory) {
              factory = name as Function
              dependencies = []
            }
          }

          // Some UMD packages depend on an "exports" object, which shouldn't
          // be required like normal objects.
          prepareDependencies = (dependencies as string[]).slice(0)
          let index = prepareDependencies.indexOf('exports')
          if (index !== -1) {
            prepareDependencies.splice(index, 1)
          }
        
          moduleWrapper = new ModuleWrapper(this, id, dependencyVersionRanges, function(require, module, exports) {
            let factoryResult = factory.apply(null, (dependencies as string[]).map(function(dep) { return dep === 'exports' ? exports : require(dep) }))
            if (factoryResult !== undefined) {
              module.exports = factoryResult
            }
          })
        }

        define.amd = true

        let fn = createFunction(['define'].concat(globalNames), code)
        let args = [define].concat(globalValues);
        fn.apply(this.options.moduleThis, args)
      }
      else if (!isPreloadModule) {
        globalNames.push('require','module','exports')
        prepareDependencies = dependencies
        let moduleFunction = createFunction(globalNames, code)
        let boundModuleFunction = Function.prototype.bind.apply(moduleFunction, [this.options.moduleThis].concat(globalValues))

        moduleWrapper = new ModuleWrapper(this, id, dependencyVersionRanges, boundModuleFunction)
      } else {
        moduleWrapper = new ModuleWrapper(this, id, dependencyVersionRanges, () => {});
        moduleWrapper.module.exports = preloadedModule;
      }

      this.resolver.registerId(id)
      this.moduleWrappers[id] = moduleWrapper

      let preparedPromise = moduleWrapper.prepare(prepareDependencies, requiredBy)

      if (!isPreloadModule) {
        if (requiredBy.length === 0) {
          preparedPromise.catch(error => this.setError(error, { errorModuleId: id }))
          preparedPromise = preparedPromise.then(this.handleUnrequiredPrepared)
          preparedPromise.catch(error => this.setError(error, { errorModuleId: id }))
        }
      } else {
        // assume we have the module already executed
        moduleWrapper.module.loaded = true
      }

      return preparedPromise
    }
    catch (error) {
      this.setError(error, { errorModuleId: id })
      return Promise.reject(error)
    }
  }
  
  private handleUnrequiredPrepared = (moduleWrapper: ModuleWrapper): ModuleWrapper => {
    if (!this.hasCalledOnEntry) {
      this.options.onEntry!()
    }
    moduleWrapper.execute()
    return moduleWrapper
  }

  // If we encounter any error while loading/executing modules, stop loading
  // subsequent modules and notify our owner.
  private setError = (error, errorDetail?:{ errorModuleId: string }) => {
    let lastError = this.error
    this.error = error
    this.errorDetail = errorDetail
    if (lastError !== error) {
      if (this.options.onError) {
        this.options.onError(error)
      }
      else {
        console.error("Error encountered while loading module:", error)
      }
    }
  }
}


export interface RequireFunction {
  (request: string): any;
  resolve: (url: string) => string;
}

export type ModuleFunction = (require: RequireFunction, module: Module, exports: any) => any

export interface Module {
  exports: any
  id: string
  loaded: boolean
  require: RequireFunction
}

export class ModuleWrapper {
  module: Module

  dependencyVersionRanges: VersionRanges

  polestar: Polestar
  fn: ModuleFunction

  // A promise that resolves once all dependency modules have been loaded,
  // and the module can be executed
  isPrepared: boolean
  preparedPromise: Promise<ModuleWrapper>
  rejectPrepared: (error: any) => void
  resolvePrepared: (moduleWrapper: ModuleWrapper) => void

  // A list of modules that are waiting for *this* module. We keep track of
  // this, as we can't wait for any of these modules without causing deadlock.
  requiredBy: Set<ModuleWrapper>

  // The urls that we're waiting for before the module can be executed.
  // Note that these need to be stored as URL string instead of module objects,
  // as the modules we're waiting for won't exist when we start waiting for
  // them.
  waitingFor: string[]
  dynamicImports: Map<string, Promise<ModuleWrapper>>

  constructor(
    loader: Polestar,
    id: string,
    dependencyVersionRanges: { [name: string]: string },
    fn: ModuleFunction,
  ) {
    this.requiredBy = new Set()
    this.waitingFor = []
    this.fn = fn
    this.polestar = loader
    this.dependencyVersionRanges = dependencyVersionRanges
    this.isPrepared
    this.preparedPromise = new Promise((resolve, reject) => {
      this.resolvePrepared = resolve
      this.rejectPrepared = reject
    })
    this.dynamicImports = new Map()

    const require: RequireFunction = ((request) => {
      let requestedId = require.resolve(request)

      if (id === requestedId) {
        throw new CyclicDependencyError(id)
      }

      let requestedWrapper = loader.moduleWrappers[requestedId]
      if (!requestedWrapper) {
        return this.dynamicImports.get(request)
          .then(moduleWrapper => {
            if (!moduleWrapper.module.loaded) {
              moduleWrapper.execute()
            }
            return moduleWrapper.module.exports
          })
          .catch(error => {
            throw new UnresolvableError(request, id)
          });
      }

      if (!requestedWrapper.module.loaded) {
        requestedWrapper.execute()
      }

      return requestedWrapper.module.exports
    }) as RequireFunction

    require.resolve = (request) => {
      let result = this.polestar.resolve(request, id, dependencyVersionRanges)
      if (result.type !== ResolutionType.Available) {
        const url = result.url
        const dynamicImportModule = this.polestar.loadWrapper(url, this, request)
        this.dynamicImports.set(request, dynamicImportModule)
        
        return url
      }
      return result.id
    }

    this.module = {
      exports: {},
      id: id,
      loaded: false,
      require,
    }
  }

  // Actually execute the module code
  execute() {
    let module = this.module

    // This should never happen, but just in case...
    if (module.loaded) {
      throw new Error(`Can't execute module ${this.module.id} twice.`)
    }

    module.loaded = true

    this.fn(module.require, module, module.exports)
  }

  // This is separate from the constructor, as it allows the loader to
  // register this module under multiple URLs before loading/preparing any
  // of the module's dependencies.
  prepare(dependencyRequests: string[] = [], requiredByWrappers: ModuleWrapper[] = []) {
    // Build a set of all all modules depending on us, modules depending on
    // modules depending on us, etc.
    for (let i = 0; i < requiredByWrappers.length; i++) {
      let requiredBy = requiredByWrappers[i]
      this.addRequiredBy(requiredBy)
      requiredBy.requiredBy.forEach(this.addRequiredBy)
    }

    for (let i = 0; i < dependencyRequests.length; i++) {
      let request = dependencyRequests[i]
      if (request) {
        let result = this.polestar.resolve(request, this.module.id, this.dependencyVersionRanges)
        if (result.type === ResolutionType.Available) {
          let dependencyWrapper = this.polestar.moduleWrappers[result.id]
          // If the requested module depends on us, then waiting for the
          // requested module to be ready will result in deadlock.
          if (!this.requiredBy.has(dependencyWrapper) && !dependencyWrapper.isPrepared) {
            this.waitingFor.push(result.id)
            dependencyWrapper.preparedPromise
              .then(getWrapperId)
              .then(this.stopWaitingFor)
              .catch(this.rejectPrepared)
          }
        }
        else {
          let url = result.url
          this.waitingFor.push(result.url)
          this.polestar.loadWrapper(url, this, request)
            .then(() => this.stopWaitingFor(url))
            .catch(this.rejectPrepared)
        }
      }
    }

    if (!this.waitingFor.length) {
      this.isPrepared = true
      this.resolvePrepared(this)
    }

    return this.preparedPromise
  }

  addToRequiredBy(requiredByWrappers: ModuleWrapper[]) {
    // Update our list of modules that are waiting for us, any modules
    // that are waiting for modules that are waiting for us, etc.
    for (let i = 0; i < requiredByWrappers.length; i++) {
      let requiredBy = requiredByWrappers[i]
      this.addRequiredBy(requiredBy)
      requiredBy.requiredBy.forEach(this.addRequiredBy)
    }

    // Stop waiting for any modules that are waiting for us, any modules
    // that are waiting for modules that are waiting for us, etc.
    for (let i = 0; i < this.waitingFor.length; i++) {
      let waitingForURL = this.waitingFor[i]
      let result = this.polestar.resolve(waitingForURL, this.module.id, this.dependencyVersionRanges)

      // It can't be waiting for us if it hasn't loaded yet
      if (result.type === ResolutionType.Available && this.requiredBy.has(this.polestar.moduleWrappers[result.id])) {
        this.stopWaitingFor(waitingForURL)
      }
    }
  }

  private stopWaitingFor = (url: string) => {
    let index = this.waitingFor.indexOf(url)
    if (index !== -1) {
      this.waitingFor.splice(index, 1)
      if (this.waitingFor.length === 0) {
        this.isPrepared = true
        this.resolvePrepared(this)
      }
    }
  }

  private addRequiredBy = (moduleWrapper) => {
    this.requiredBy.add(moduleWrapper)
  }
}

function getWrapperId(moduleWrapper: ModuleWrapper) {
  return moduleWrapper.module.id
}

function getModule(moduleWrapper: ModuleWrapper) {
  return moduleWrapper.module
}