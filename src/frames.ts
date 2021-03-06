/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import * as util from 'util';
import { ConsoleMessage } from './console';
import * as dom from './dom';
import { NotConnectedError } from './errors';
import { Events } from './events';
import { assert, helper, RegisteredListener, assertMaxArguments, debugAssert } from './helper';
import * as js from './javascript';
import * as network from './network';
import { Page } from './page';
import { selectors } from './selectors';
import * as types from './types';
import { waitForTimeoutWasUsed } from './hints';
import { BrowserContext } from './browserContext';
import { Progress, ProgressController, runAbortableTask } from './progress';
import { apiLog } from './logger';

type ContextType = 'main' | 'utility';
type ContextData = {
  contextPromise: Promise<dom.FrameExecutionContext>;
  contextResolveCallback: (c: dom.FrameExecutionContext) => void;
  context: dom.FrameExecutionContext | null;
  rerunnableTasks: Set<RerunnableTask<any>>;
};

export type GotoOptions = types.NavigateOptions & {
  referer?: string,
};
export type GotoResult = {
  newDocumentId?: string,
};

type ConsoleTagHandler = () => void;

export type FunctionWithSource = (source: { context: BrowserContext, page: Page, frame: Frame}, ...args: any) => any;

export class FrameManager {
  private _page: Page;
  private _frames = new Map<string, Frame>();
  private _mainFrame: Frame;
  readonly _consoleMessageTags = new Map<string, ConsoleTagHandler>();
  readonly _signalBarriers = new Set<SignalBarrier>();

  constructor(page: Page) {
    this._page = page;
    this._mainFrame = undefined as any as Frame;
  }

  mainFrame(): Frame {
    return this._mainFrame;
  }

  frames() {
    const frames: Frame[] = [];
    collect(this._mainFrame);
    return frames;

    function collect(frame: Frame) {
      frames.push(frame);
      for (const subframe of frame.childFrames())
        collect(subframe);
    }
  }

  frame(frameId: string): Frame | null {
    return this._frames.get(frameId) || null;
  }

  frameAttached(frameId: string, parentFrameId: string | null | undefined): Frame {
    const parentFrame = parentFrameId ? this._frames.get(parentFrameId)! : null;
    if (!parentFrame) {
      if (this._mainFrame) {
        // Update frame id to retain frame identity on cross-process navigation.
        this._frames.delete(this._mainFrame._id);
        this._mainFrame._id = frameId;
      } else {
        assert(!this._frames.has(frameId));
        this._mainFrame = new Frame(this._page, frameId, parentFrame);
      }
      this._frames.set(frameId, this._mainFrame);
      return this._mainFrame;
    } else {
      assert(!this._frames.has(frameId));
      const frame = new Frame(this._page, frameId, parentFrame);
      this._frames.set(frameId, frame);
      this._page.emit(Events.Page.FrameAttached, frame);
      return frame;
    }
  }

  async waitForSignalsCreatedBy<T>(progress: Progress | null, noWaitAfter: boolean | undefined, action: () => Promise<T>, source?: 'input'): Promise<T> {
    if (noWaitAfter)
      return action();
    const barrier = new SignalBarrier(progress);
    this._signalBarriers.add(barrier);
    if (progress)
      progress.cleanupWhenAborted(() => this._signalBarriers.delete(barrier));
    const result = await action();
    if (source === 'input')
      await this._page._delegate.inputActionEpilogue();
    await barrier.waitFor();
    this._signalBarriers.delete(barrier);
    // Resolve in the next task, after all waitForNavigations.
    await new Promise(helper.makeWaitForNextTask());
    return result;
  }

  frameWillPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.retain();
  }

  frameDidPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.release();
  }

  frameRequestedNavigation(frameId: string, documentId: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    for (const barrier of this._signalBarriers)
      barrier.addFrameNavigation(frame);
    frame._pendingDocumentId = documentId;
  }

  frameUpdatedDocumentIdForNavigation(frameId: string, documentId: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    frame._pendingDocumentId = documentId;
  }

  frameCommittedNewDocumentNavigation(frameId: string, url: string, name: string, documentId: string, initial: boolean) {
    const frame = this._frames.get(frameId)!;
    this.removeChildFramesRecursively(frame);
    frame._url = url;
    frame._name = name;
    debugAssert(!frame._pendingDocumentId || frame._pendingDocumentId === documentId);
    frame._lastDocumentId = documentId;
    frame._pendingDocumentId = '';
    for (const task of frame._frameTasks)
      task.onNewDocument(documentId);
    this.clearFrameLifecycle(frame);
    if (!initial)
      this._page.emit(Events.Page.FrameNavigated, frame);
  }

  frameCommittedSameDocumentNavigation(frameId: string, url: string) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    frame._url = url;
    for (const task of frame._frameTasks)
      task.onSameDocument();
    this._page.emit(Events.Page.FrameNavigated, frame);
  }

  frameDetached(frameId: string) {
    const frame = this._frames.get(frameId);
    if (frame)
      this._removeFramesRecursively(frame);
  }

  frameStoppedLoading(frameId: string) {
    this.frameLifecycleEvent(frameId, 'domcontentloaded');
    this.frameLifecycleEvent(frameId, 'load');
  }

  frameLifecycleEvent(frameId: string, event: types.LifecycleEvent) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    if (frame._firedLifecycleEvents.has(event))
      return;
    frame._firedLifecycleEvents.add(event);
    this._notifyLifecycle(frame, event);
    if (frame === this._mainFrame && event === 'load')
      this._page.emit(Events.Page.Load);
    if (frame === this._mainFrame && event === 'domcontentloaded')
      this._page.emit(Events.Page.DOMContentLoaded);
  }

  clearFrameLifecycle(frame: Frame) {
    frame._firedLifecycleEvents.clear();
    // Keep the current navigation request if any.
    frame._inflightRequests = new Set(Array.from(frame._inflightRequests).filter(request => request._documentId === frame._lastDocumentId));
    frame._stopNetworkIdleTimer();
    if (frame._inflightRequests.size === 0)
      frame._startNetworkIdleTimer();
  }

  requestStarted(request: network.Request) {
    this._inflightRequestStarted(request);
    for (const task of request.frame()._frameTasks)
      task.onRequest(request);
    if (request._isFavicon) {
      const route = request._route();
      if (route)
        route.continue();
      return;
    }
    this._page._requestStarted(request);
  }

  requestReceivedResponse(response: network.Response) {
    if (!response.request()._isFavicon)
      this._page.emit(Events.Page.Response, response);
  }

  requestFinished(request: network.Request) {
    this._inflightRequestFinished(request);
    if (!request._isFavicon)
      this._page.emit(Events.Page.RequestFinished, request);
  }

  requestFailed(request: network.Request, canceled: boolean) {
    this._inflightRequestFinished(request);
    if (request._documentId) {
      const isPendingDocument = request.frame()._pendingDocumentId === request._documentId;
      if (isPendingDocument) {
        request.frame()._pendingDocumentId = '';
        let errorText = request.failure()!.errorText;
        if (canceled)
          errorText += '; maybe frame was detached?';
        for (const task of request.frame()._frameTasks)
          task.onNewDocument(request._documentId, new Error(errorText));
      }
    }
    if (!request._isFavicon)
      this._page.emit(Events.Page.RequestFailed, request);
  }

  provisionalLoadFailed(frame: Frame, documentId: string, error: string) {
    for (const task of frame._frameTasks)
      task.onNewDocument(documentId, new Error(error));
  }

  private _notifyLifecycle(frame: Frame, lifecycleEvent: types.LifecycleEvent) {
    for (let parent: Frame | null = frame; parent; parent = parent.parentFrame()) {
      for (const frameTask of parent._frameTasks)
        frameTask.onLifecycle(frame, lifecycleEvent);
    }
  }

  removeChildFramesRecursively(frame: Frame) {
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
  }

  private _removeFramesRecursively(frame: Frame) {
    this.removeChildFramesRecursively(frame);
    frame._onDetached();
    this._frames.delete(frame._id);
    this._page.emit(Events.Page.FrameDetached, frame);
  }

  private _inflightRequestFinished(request: network.Request) {
    const frame = request.frame();
    if (request._isFavicon)
      return;
    if (!frame._inflightRequests.has(request))
      return;
    frame._inflightRequests.delete(request);
    if (frame._inflightRequests.size === 0)
      frame._startNetworkIdleTimer();
  }

  private _inflightRequestStarted(request: network.Request) {
    const frame = request.frame();
    if (request._isFavicon)
      return;
    frame._inflightRequests.add(request);
    if (frame._inflightRequests.size === 1)
      frame._stopNetworkIdleTimer();
  }

  interceptConsoleMessage(message: ConsoleMessage): boolean {
    if (message.type() !== 'debug')
      return false;
    const tag = message.text();
    const handler = this._consoleMessageTags.get(tag);
    if (!handler)
      return false;
    this._consoleMessageTags.delete(tag);
    handler();
    return true;
  }
}

export class Frame {
  _id: string;
  readonly _firedLifecycleEvents: Set<types.LifecycleEvent>;
  _lastDocumentId = '';
  _pendingDocumentId = '';
  _frameTasks = new Set<FrameTask>();
  readonly _page: Page;
  private _parentFrame: Frame | null;
  _url = '';
  private _detached = false;
  private _contextData = new Map<ContextType, ContextData>();
  private _childFrames = new Set<Frame>();
  _name = '';
  _inflightRequests = new Set<network.Request>();
  private _networkIdleTimer: NodeJS.Timer | undefined;
  private _setContentCounter = 0;
  readonly _detachedPromise: Promise<void>;
  private _detachedCallback = () => {};

  constructor(page: Page, id: string, parentFrame: Frame | null) {
    this._id = id;
    this._firedLifecycleEvents = new Set();
    this._page = page;
    this._parentFrame = parentFrame;

    this._detachedPromise = new Promise<void>(x => this._detachedCallback = x);

    this._contextData.set('main', { contextPromise: new Promise(() => {}), contextResolveCallback: () => {}, context: null, rerunnableTasks: new Set() });
    this._contextData.set('utility', { contextPromise: new Promise(() => {}), contextResolveCallback: () => {}, context: null, rerunnableTasks: new Set() });
    this._setContext('main', null);
    this._setContext('utility', null);

    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
  }

  async goto(url: string, options: GotoOptions = {}): Promise<network.Response | null> {
    const progressController = new ProgressController(options, this._page, this._page._timeoutSettings.navigationTimeout());
    abortProgressOnFrameDetach(progressController, this);
    return progressController.run(async progress => {
      progress.log(apiLog, `${progress.apiName}("${url}"), waiting until "${options.waitUntil || 'load'}"`);
      const headers = (this._page._state.extraHTTPHeaders || {});
      let referer = headers['referer'] || headers['Referer'];
      if (options.referer !== undefined) {
        if (referer !== undefined && referer !== options.referer)
          throw new Error('"referer" is already specified as extra HTTP header');
        referer = options.referer;
      }
      url = helper.completeUserURL(url);

      const frameTask = new FrameTask(this, progress);
      const sameDocumentPromise = frameTask.waitForSameDocumentNavigation();
      const navigateResult = await this._page._delegate.navigateFrame(this, url, referer).catch(e => {
        // Do not leave sameDocumentPromise unhandled.
        sameDocumentPromise.catch(e => {});
        throw e;
      });
      if (navigateResult.newDocumentId) {
        // Do not leave sameDocumentPromise unhandled.
        sameDocumentPromise.catch(e => {});
        await frameTask.waitForSpecificDocument(navigateResult.newDocumentId);
      } else {
        await sameDocumentPromise;
      }
      const request = (navigateResult && navigateResult.newDocumentId) ? frameTask.request(navigateResult.newDocumentId) : null;
      await frameTask.waitForLifecycle(options.waitUntil === undefined ? 'load' : options.waitUntil);
      frameTask.done();
      return request ? request._finalRequest().response() : null;
    });
  }

  async waitForNavigation(options: types.WaitForNavigationOptions = {}): Promise<network.Response | null> {
    const progressController = new ProgressController(options, this._page, this._page._timeoutSettings.navigationTimeout());
    abortProgressOnFrameDetach(progressController, this);
    return progressController.run(async progress => {
      const toUrl = typeof options.url === 'string' ? ` to "${options.url}"` : '';
      progress.log(apiLog, `waiting for navigation${toUrl} until "${options.waitUntil || 'load'}"`);
      const frameTask = new FrameTask(this, progress);
      let documentId: string | undefined;
      await Promise.race([
        frameTask.waitForNewDocument(options.url).then(id => documentId = id),
        frameTask.waitForSameDocumentNavigation(options.url),
      ]);
      const request = documentId ? frameTask.request(documentId) : null;
      await frameTask.waitForLifecycle(options.waitUntil === undefined ? 'load' : options.waitUntil);
      frameTask.done();
      return request ? request._finalRequest().response() : null;
    });
  }

  async waitForLoadState(state: types.LifecycleEvent = 'load', options: types.TimeoutOptions = {}): Promise<void> {
    const progressController = new ProgressController(options, this._page, this._page._timeoutSettings.navigationTimeout());
    abortProgressOnFrameDetach(progressController, this);
    return progressController.run(progress => this._waitForLoadState(progress, state));
  }

  async _waitForLoadState(progress: Progress, state: types.LifecycleEvent): Promise<void> {
    const frameTask = new FrameTask(this, progress);
    await frameTask.waitForLifecycle(state);
    frameTask.done();
  }

  async frameElement(): Promise<dom.ElementHandle> {
    return this._page._delegate.getFrameElement(this);
  }

  _context(contextType: ContextType): Promise<dom.FrameExecutionContext> {
    if (this._detached)
      throw new Error(`Execution Context is not available in detached frame "${this.url()}" (are you trying to evaluate?)`);
    return this._contextData.get(contextType)!.contextPromise;
  }

  _mainContext(): Promise<dom.FrameExecutionContext> {
    return this._context('main');
  }

  _utilityContext(): Promise<dom.FrameExecutionContext> {
    return this._context('utility');
  }

  async evaluateHandle<R, Arg>(pageFunction: types.Func1<Arg, R>, arg: Arg): Promise<types.SmartHandle<R>>;
  async evaluateHandle<R>(pageFunction: types.Func1<void, R>, arg?: any): Promise<types.SmartHandle<R>>;
  async evaluateHandle<R, Arg>(pageFunction: types.Func1<Arg, R>, arg: Arg): Promise<types.SmartHandle<R>> {
    assertMaxArguments(arguments.length, 2);
    const context = await this._mainContext();
    return context.evaluateHandleInternal(pageFunction, arg);
  }

  async evaluate<R, Arg>(pageFunction: types.Func1<Arg, R>, arg: Arg): Promise<R>;
  async evaluate<R>(pageFunction: types.Func1<void, R>, arg?: any): Promise<R>;
  async evaluate<R, Arg>(pageFunction: types.Func1<Arg, R>, arg: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    const context = await this._mainContext();
    return context.evaluateInternal(pageFunction, arg);
  }

  async $(selector: string): Promise<dom.ElementHandle<Element> | null> {
    return selectors._query(this, selector);
  }

  async waitForSelector(selector: string, options: types.WaitForElementOptions = {}): Promise<dom.ElementHandle<Element> | null> {
    if ((options as any).visibility)
      throw new Error('options.visibility is not supported, did you mean options.state?');
    if ((options as any).waitFor && (options as any).waitFor !== 'visible')
      throw new Error('options.waitFor is not supported, did you mean options.state?');
    const { state = 'visible' } = options;
    if (!['attached', 'detached', 'visible', 'hidden'].includes(state))
      throw new Error(`Unsupported waitFor option "${state}"`);
    const { world, task } = selectors._waitForSelectorTask(selector, state);
    return runAbortableTask(async progress => {
      progress.log(apiLog, `Waiting for selector "${selector}"${state === 'attached' ? '' : ' to be ' + state}...`);
      const result = await this._scheduleRerunnableTask(progress, world, task);
      if (!result.asElement()) {
        result.dispose();
        return null;
      }
      const handle = result.asElement() as dom.ElementHandle<Element>;
      const mainContext = await this._mainContext();
      if (handle && handle._context !== mainContext) {
        const adopted = await this._page._delegate.adoptElementHandle(handle, mainContext);
        handle.dispose();
        return adopted;
      }
      return handle;
    }, options, this._page, this._page._timeoutSettings);
  }

  async dispatchEvent(selector: string, type: string, eventInit?: Object, options?: types.TimeoutOptions): Promise<void> {
    const task = selectors._dispatchEventTask(selector, type, eventInit || {});
    return runAbortableTask(async progress => {
      progress.log(apiLog, `Dispatching "${type}" event on selector "${selector}"...`);
      const result = await this._scheduleRerunnableTask(progress, 'main', task);
      result.dispose();
    }, options || {}, this._page, this._page._timeoutSettings);
  }

  async $eval<R, Arg>(selector: string, pageFunction: types.FuncOn<Element, Arg, R>, arg: Arg): Promise<R>;
  async $eval<R>(selector: string, pageFunction: types.FuncOn<Element, void, R>, arg?: any): Promise<R>;
  async $eval<R, Arg>(selector: string, pageFunction: types.FuncOn<Element, Arg, R>, arg: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    const handle = await this.$(selector);
    if (!handle)
      throw new Error(`Error: failed to find element matching selector "${selector}"`);
    const result = await handle.evaluate(pageFunction, arg);
    handle.dispose();
    return result;
  }

  async $$eval<R, Arg>(selector: string, pageFunction: types.FuncOn<Element[], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<R>(selector: string, pageFunction: types.FuncOn<Element[], void, R>, arg?: any): Promise<R>;
  async $$eval<R, Arg>(selector: string, pageFunction: types.FuncOn<Element[], Arg, R>, arg: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    const arrayHandle = await selectors._queryArray(this, selector);
    const result = await arrayHandle.evaluate(pageFunction, arg);
    arrayHandle.dispose();
    return result;
  }

  async $$(selector: string): Promise<dom.ElementHandle<Element>[]> {
    return selectors._queryAll(this, selector);
  }

  async content(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluateInternal(() => {
      let retVal = '';
      if (document.doctype)
        retVal = new XMLSerializer().serializeToString(document.doctype);
      if (document.documentElement)
        retVal += document.documentElement.outerHTML;
      return retVal;
    });
  }

  async setContent(html: string, options: types.NavigateOptions = {}): Promise<void> {
    const progressController = new ProgressController(options, this._page, this._page._timeoutSettings.navigationTimeout());
    abortProgressOnFrameDetach(progressController, this);
    return progressController.run(async progress => {
      const waitUntil = options.waitUntil === undefined ? 'load' : options.waitUntil;
      progress.log(apiLog, `${progress.apiName}(), waiting until "${waitUntil}"`);
      const tag = `--playwright--set--content--${this._id}--${++this._setContentCounter}--`;
      const context = await this._utilityContext();
      const lifecyclePromise = new Promise((resolve, reject) => {
        this._page._frameManager._consoleMessageTags.set(tag, () => {
          progress.log(apiLog, 'content written');
          // Clear lifecycle right after document.open() - see 'tag' below.
          this._page._frameManager.clearFrameLifecycle(this);
          this._waitForLoadState(progress, waitUntil).then(resolve).catch(reject);
        });
      });
      const contentPromise = context.evaluateInternal(({ html, tag }) => {
        window.stop();
        document.open();
        console.debug(tag);  // eslint-disable-line no-console
        document.write(html);
        document.close();
      }, { html, tag });
      await Promise.all([contentPromise, lifecyclePromise]);
    });
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  isDetached(): boolean {
    return this._detached;
  }

  async addScriptTag(options: {
      url?: string; path?: string;
      content?: string;
      type?: string;
    }): Promise<dom.ElementHandle> {
    const {
      url = null,
      path = null,
      content = null,
      type = ''
    } = options;
    if (!url && !path && !content)
      throw new Error('Provide an object with a `url`, `path` or `content` property');

    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandleInternal(addScriptUrl, { url, type })).asElement()!;
      let result;
      if (path !== null) {
        let contents = await util.promisify(fs.readFile)(path, 'utf8');
        contents += '//# sourceURL=' + path.replace(/\n/g, '');
        result = (await context.evaluateHandleInternal(addScriptContent, { content: contents, type })).asElement()!;
      } else {
        result = (await context.evaluateHandleInternal(addScriptContent, { content: content!, type })).asElement()!;
      }
      // Another round trip to the browser to ensure that we receive CSP error messages
      // (if any) logged asynchronously in a separate task on the content main thread.
      if (this._page._delegate.cspErrorsAsynchronousForInlineScipts)
        await context.evaluateInternal(() => true);
      return result;
    });

    async function addScriptUrl(options: { url: string, type: string }): Promise<HTMLElement> {
      const script = document.createElement('script');
      script.src = options.url;
      if (options.type)
        script.type = options.type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = e => rej(typeof e === 'string' ? new Error(e) : new Error(`Failed to load script at ${script.src}`));
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    function addScriptContent(options: { content: string, type: string }): HTMLElement {
      const script = document.createElement('script');
      script.type = options.type || 'text/javascript';
      script.text = options.content;
      let error = null;
      script.onerror = e => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string; }): Promise<dom.ElementHandle> {
    const {
      url = null,
      path = null,
      content = null
    } = options;
    if (!url && !path && !content)
      throw new Error('Provide an object with a `url`, `path` or `content` property');

    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandleInternal(addStyleUrl, url)).asElement()!;

      if (path !== null) {
        let contents = await util.promisify(fs.readFile)(path, 'utf8');
        contents += '/*# sourceURL=' + path.replace(/\n/g, '') + '*/';
        return (await context.evaluateHandleInternal(addStyleContent, contents)).asElement()!;
      }

      return (await context.evaluateHandleInternal(addStyleContent, content!)).asElement()!;
    });

    async function addStyleUrl(url: string): Promise<HTMLElement> {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    async function addStyleContent(content: string): Promise<HTMLElement> {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  private async _raceWithCSPError(func: () => Promise<dom.ElementHandle>): Promise<dom.ElementHandle> {
    const listeners: RegisteredListener[] = [];
    let result: dom.ElementHandle;
    let error: Error | undefined;
    let cspMessage: ConsoleMessage | undefined;
    const actionPromise = new Promise<dom.ElementHandle>(async resolve => {
      try {
        result = await func();
      } catch (e) {
        error = e;
      }
      resolve();
    });
    const errorPromise = new Promise(resolve => {
      listeners.push(helper.addEventListener(this._page, Events.Page.Console, (message: ConsoleMessage) => {
        if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
          cspMessage = message;
          resolve();
        }
      }));
    });
    await Promise.race([actionPromise, errorPromise]);
    helper.removeEventListeners(listeners);
    if (cspMessage)
      throw new Error(cspMessage.text());
    if (error)
      throw error;
    return result!;
  }

  private async _retryWithSelectorIfNotConnected<R>(
    selector: string, options: types.TimeoutOptions,
    action: (progress: Progress, handle: dom.ElementHandle<Element>) => Promise<R>): Promise<R> {
    return runAbortableTask(async progress => {
      progress.log(apiLog, `${progress.apiName}("${selector}")`);
      while (progress.isRunning()) {
        try {
          const { world, task } = selectors._waitForSelectorTask(selector, 'attached');
          progress.log(apiLog, `waiting for the selector "${selector}"`);
          const handle = await this._scheduleRerunnableTask(progress, world, task);
          progress.log(apiLog, `...got element for the selector`);
          const element = handle.asElement() as dom.ElementHandle<Element>;
          progress.cleanupWhenAborted(() => element.dispose());
          const result = await action(progress, element);
          element.dispose();
          return result;
        } catch (e) {
          if (!(e instanceof NotConnectedError))
            throw e;
          progress.log(apiLog, 'element was detached from the DOM, retrying');
        }
      }
      return undefined as any;
    }, options, this._page, this._page._timeoutSettings);
  }

  async click(selector: string, options: dom.ClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._click(progress, options));
  }

  async dblclick(selector: string, options: dom.MultiClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._dblclick(progress, options));
  }

  async fill(selector: string, value: string, options: types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._fill(progress, value, options));
  }

  async focus(selector: string, options: types.TimeoutOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle.focus());
  }

  async textContent(selector: string, options: types.TimeoutOptions = {}): Promise<null|string> {
    return await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle.textContent());
  }

  async innerText(selector: string, options: types.TimeoutOptions = {}): Promise<string> {
    return await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle.innerText());
  }

  async innerHTML(selector: string, options: types.TimeoutOptions = {}): Promise<string> {
    return await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle.innerHTML());
  }

  async getAttribute(selector: string, name: string, options: types.TimeoutOptions = {}): Promise<string | null> {
    return await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle.getAttribute(name));
  }

  async hover(selector: string, options: dom.PointerActionOptions & types.PointerActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._hover(progress, options));
  }

  async selectOption(selector: string, values: string | dom.ElementHandle | types.SelectOption | string[] | dom.ElementHandle[] | types.SelectOption[], options: types.NavigatingActionWaitOptions = {}): Promise<string[]> {
    return this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._selectOption(progress, values, options));
  }

  async setInputFiles(selector: string, files: string | types.FilePayload | string[] | types.FilePayload[], options: types.NavigatingActionWaitOptions = {}): Promise<void> {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._setInputFiles(progress, files, options));
  }

  async type(selector: string, text: string, options: { delay?: number } & types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._type(progress, text, options));
  }

  async press(selector: string, key: string, options: { delay?: number } & types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._press(progress, key, options));
  }

  async check(selector: string, options: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._setChecked(progress, true, options));
  }

  async uncheck(selector: string, options: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}) {
    await this._retryWithSelectorIfNotConnected(selector, options, (progress, handle) => handle._setChecked(progress, false, options));
  }

  async waitForTimeout(timeout: number) {
    waitForTimeoutWasUsed(this._page);
    await new Promise(fulfill => setTimeout(fulfill, timeout));
  }

  async waitForFunction<R, Arg>(pageFunction: types.Func1<Arg, R>, arg: Arg, options?: types.WaitForFunctionOptions): Promise<types.SmartHandle<R>>;
  async waitForFunction<R>(pageFunction: types.Func1<void, R>, arg?: any, options?: types.WaitForFunctionOptions): Promise<types.SmartHandle<R>>;
  async waitForFunction<R, Arg>(pageFunction: types.Func1<Arg, R>, arg: Arg, options: types.WaitForFunctionOptions = {}): Promise<types.SmartHandle<R>> {
    const { polling = 'raf' } = options;
    if (helper.isString(polling))
      assert(polling === 'raf', 'Unknown polling option: ' + polling);
    else if (helper.isNumber(polling))
      assert(polling > 0, 'Cannot poll with non-positive interval: ' + polling);
    else
      throw new Error('Unknown polling options: ' + polling);
    const predicateBody = helper.isString(pageFunction) ? 'return (' + pageFunction + ')' : 'return (' + pageFunction + ')(arg)';
    const task = async (context: dom.FrameExecutionContext) => {
      const injectedScript = await context.injectedScript();
      return context.evaluateHandleInternal(({ injectedScript, predicateBody, polling, arg }) => {
        const innerPredicate = new Function('arg', predicateBody) as (arg: any) => R;
        return injectedScript.poll(polling, () => innerPredicate(arg));
      }, { injectedScript, predicateBody, polling, arg });
    };
    return runAbortableTask(
        progress => this._scheduleRerunnableTask(progress, 'main', task),
        options, this._page, this._page._timeoutSettings);
  }

  async title(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluateInternal(() => document.title);
  }

  _onDetached() {
    this._detached = true;
    this._detachedCallback();
    for (const data of this._contextData.values()) {
      for (const rerunnableTask of data.rerunnableTasks)
        rerunnableTask.terminate(new Error('waitForFunction failed: frame got detached.'));
    }
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }

  private _scheduleRerunnableTask<T>(progress: Progress, contextType: ContextType, task: SchedulableTask<T>): Promise<types.SmartHandle<T>> {
    const data = this._contextData.get(contextType)!;
    const rerunnableTask = new RerunnableTask(data, progress, task);
    if (data.context)
      rerunnableTask.rerun(data.context);
    return rerunnableTask.promise;
  }

  private _setContext(contextType: ContextType, context: dom.FrameExecutionContext | null) {
    const data = this._contextData.get(contextType)!;
    data.context = context;
    if (context) {
      data.contextResolveCallback.call(null, context);
      for (const rerunnableTask of data.rerunnableTasks)
        rerunnableTask.rerun(context);
    } else {
      data.contextPromise = new Promise(fulfill => {
        data.contextResolveCallback = fulfill;
      });
    }
  }

  _contextCreated(contextType: ContextType, context: dom.FrameExecutionContext) {
    const data = this._contextData.get(contextType)!;
    // In case of multiple sessions to the same target, there's a race between
    // connections so we might end up creating multiple isolated worlds.
    // We can use either.
    if (data.context)
      this._setContext(contextType, null);
    this._setContext(contextType, context);
  }

  _contextDestroyed(context: dom.FrameExecutionContext) {
    for (const [contextType, data] of this._contextData) {
      if (data.context === context)
        this._setContext(contextType, null);
    }
  }

  _startNetworkIdleTimer() {
    assert(!this._networkIdleTimer);
    if (this._firedLifecycleEvents.has('networkidle'))
      return;
    this._networkIdleTimer = setTimeout(() => { this._page._frameManager.frameLifecycleEvent(this._id, 'networkidle'); }, 500);
  }

  _stopNetworkIdleTimer() {
    if (this._networkIdleTimer)
      clearTimeout(this._networkIdleTimer);
    this._networkIdleTimer = undefined;
  }
}

export type SchedulableTask<T> = (context: dom.FrameExecutionContext) => Promise<js.JSHandle<types.InjectedScriptPoll<T>>>;

class RerunnableTask<T> {
  readonly promise: Promise<types.SmartHandle<T>>;
  private _task: SchedulableTask<T>;
  private _resolve: (result: types.SmartHandle<T>) => void = () => {};
  private _reject: (reason: Error) => void = () => {};
  private _progress: Progress;

  constructor(data: ContextData, progress: Progress, task: SchedulableTask<T>) {
    this._task = task;
    this._progress = progress;
    data.rerunnableTasks.add(this);
    this.promise = new Promise<types.SmartHandle<T>>((resolve, reject) => {
      // The task is either resolved with a value, or rejected with a meaningful evaluation error.
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  terminate(error: Error) {
    this._reject(error);
  }

  async rerun(context: dom.FrameExecutionContext) {
    let pollHandler: dom.InjectedScriptPollHandler | null = null;
    try {
      const poll = await this._task(context);
      pollHandler = new dom.InjectedScriptPollHandler(this._progress, poll);
      const result = await poll.evaluateHandle(poll => poll.result);
      this._resolve(result);
    } catch (e) {
      if (pollHandler)
        pollHandler.cancel();

      // When the page is navigated, the promise is rejected.
      // We will try again in the new execution context.
      if (e.message.includes('Execution context was destroyed'))
        return;

      // We could have tried to evaluate in a context which was already
      // destroyed.
      if (e.message.includes('Cannot find context with specified id'))
        return;

      this._reject(e);
    }
  }
}

class SignalBarrier {
  private _progress: Progress | null;
  private _protectCount = 0;
  private _promise: Promise<void>;
  private _promiseCallback = () => {};

  constructor(progress: Progress | null) {
    this._progress = progress;
    this._promise = new Promise(f => this._promiseCallback = f);
    this.retain();
  }

  waitFor(): Promise<void> {
    this.release();
    return this._promise;
  }

  async addFrameNavigation(frame: Frame) {
    this.retain();
    const frameTask = new FrameTask(frame, this._progress);
    await Promise.race([
      frame._page._disconnectedPromise,
      frame._detachedPromise,
      frameTask.waitForNewDocument(),
      frameTask.waitForSameDocumentNavigation(),
    ]).catch(e => {});
    frameTask.done();
    this.release();
  }

  retain() {
    ++this._protectCount;
  }

  release() {
    --this._protectCount;
    if (!this._protectCount)
      this._promiseCallback();
  }
}

class FrameTask {
  private readonly _frame: Frame;
  private readonly _requestMap = new Map<string, network.Request>();
  private readonly _progress: Progress | null = null;
  private _onSameDocument?: { url?: types.URLMatch, resolve: () => void };
  private _onSpecificDocument?: { expectedDocumentId: string, resolve: () => void, reject: (error: Error) => void };
  private _onNewDocument?: { url?: types.URLMatch, resolve: (documentId: string) => void, reject: (error: Error) => void };
  private _onLifecycle?: { waitUntil: types.LifecycleEvent, resolve: () => void };

  constructor(frame: Frame, progress: Progress | null) {
    this._frame = frame;
    frame._frameTasks.add(this);
    this._progress = progress;
    if (progress)
      progress.cleanupWhenAborted(() => this.done());
  }

  onRequest(request: network.Request) {
    if (!request._documentId || request.redirectedFrom())
      return;
    this._requestMap.set(request._documentId, request);
  }

  request(documentId: string): network.Request | undefined {
    return this._requestMap.get(documentId);
  }

  onSameDocument() {
    if (this._progress)
      this._progress.log(apiLog, `navigated to "${this._frame._url}"`);
    if (this._onSameDocument && helper.urlMatches(this._frame.url(), this._onSameDocument.url))
      this._onSameDocument.resolve();
  }

  onNewDocument(documentId: string, error?: Error) {
    if (this._progress && !error)
      this._progress.log(apiLog, `navigated to "${this._frame._url}"`);
    if (this._onSpecificDocument) {
      if (documentId === this._onSpecificDocument.expectedDocumentId) {
        if (error)
          this._onSpecificDocument.reject(error);
        else
          this._onSpecificDocument.resolve();
      } else if (!error) {
        this._onSpecificDocument.reject(new Error('Navigation interrupted by another one'));
      }
    }
    if (this._onNewDocument) {
      if (error)
        this._onNewDocument.reject(error);
      else if (helper.urlMatches(this._frame.url(), this._onNewDocument.url))
        this._onNewDocument.resolve(documentId);
    }
  }

  onLifecycle(frame: Frame, lifecycleEvent: types.LifecycleEvent) {
    if (this._progress && frame === this._frame && frame._url !== 'about:blank')
      this._progress.log(apiLog, `"${lifecycleEvent}" event fired`);
    if (this._onLifecycle && this._checkLifecycleRecursively(this._frame, this._onLifecycle.waitUntil))
      this._onLifecycle.resolve();
  }

  waitForSameDocumentNavigation(url?: types.URLMatch): Promise<void> {
    return new Promise(resolve => {
      assert(!this._onSameDocument);
      this._onSameDocument = { url, resolve };
    });
  }

  waitForSpecificDocument(expectedDocumentId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      assert(!this._onSpecificDocument);
      this._onSpecificDocument = { expectedDocumentId, resolve, reject };
    });
  }

  waitForNewDocument(url?: types.URLMatch): Promise<string> {
    return new Promise((resolve, reject) => {
      assert(!this._onNewDocument);
      this._onNewDocument = { url, resolve, reject };
    });
  }

  waitForLifecycle(waitUntil: types.LifecycleEvent): Promise<void> {
    if (waitUntil as unknown === 'networkidle0')
      waitUntil = 'networkidle';
    if (!types.kLifecycleEvents.has(waitUntil))
      throw new Error(`Unsupported waitUntil option ${String(waitUntil)}`);
    if (this._checkLifecycleRecursively(this._frame, waitUntil))
      return Promise.resolve();
    return new Promise(resolve => {
      assert(!this._onLifecycle);
      this._onLifecycle = { waitUntil, resolve };
    });
  }

  private _checkLifecycleRecursively(frame: Frame, waitUntil: types.LifecycleEvent): boolean {
    if (!frame._firedLifecycleEvents.has(waitUntil))
      return false;
    for (const child of frame.childFrames()) {
      if (!this._checkLifecycleRecursively(child, waitUntil))
        return false;
    }
    return true;
  }

  done() {
    this._frame._frameTasks.delete(this);
  }
}

function abortProgressOnFrameDetach(controller: ProgressController, frame: Frame) {
  frame._page._disconnectedPromise.then(() => controller.abort(new Error('Navigation failed because browser has disconnected!')));
  frame._detachedPromise.then(() => controller.abort(new Error('Navigating frame was detached!')));
}
