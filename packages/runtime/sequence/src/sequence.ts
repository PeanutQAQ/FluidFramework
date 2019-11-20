/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ChildLogger, Deferred, fromBase64ToUtf8 } from "@microsoft/fluid-core-utils";
import { IValueChanged, MapKernel } from "@microsoft/fluid-map";
import * as MergeTree from "@microsoft/fluid-merge-tree";
import {
    FileMode,
    ISequencedDocumentMessage,
    ITree,
    MessageType,
    TreeEntry,
} from "@microsoft/fluid-protocol-definitions";
import { IChannelAttributes, IComponentRuntime, IObjectStorageService } from "@microsoft/fluid-runtime-definitions";
import { makeHandlesSerializable, parseHandles, SharedObject } from "@microsoft/fluid-shared-object-base";
import * as assert from "assert";
import { debug } from "./debug";
import {
    IntervalCollection,
    SequenceInterval,
    SequenceIntervalCollectionValueType,
} from "./intervalCollection";
import { SequenceDeltaEvent, SequenceMaintenanceEvent } from "./sequenceDeltaEvent";
import { ISharedIntervalCollection } from "./sharedIntervalCollection";
// tslint:disable-next-line: no-var-requires no-require-imports no-submodule-imports
const cloneDeep = require("lodash/cloneDeep");

const snapshotFileName = "header";
const contentPath = "content";

class ContentObjectStorage implements IObjectStorageService {
    constructor(private readonly storage: IObjectStorageService) {
    }

    /* tslint:disable:promise-function-async */
    public read(path: string): Promise<string> {
        return this.storage.read(`${contentPath}/${path}`);
    }
}

export abstract class SharedSegmentSequence<T extends MergeTree.ISegment>
    extends SharedObject
    implements ISharedIntervalCollection<SequenceInterval> {

    get loaded(): Promise<void> {
        return this.loadedDeferred.promise;
    }

    private static createOpsFromDelta(event: SequenceDeltaEvent): MergeTree.IMergeTreeOp[] {
        const ops: MergeTree.IMergeTreeOp[] = [];
        for (const r of event.ranges) {
            switch (event.deltaOperation) {
                case MergeTree.MergeTreeDeltaType.ANNOTATE:
                    const lastAnnotate = ops[ops.length - 1] as MergeTree.IMergeTreeAnnotateMsg;
                    const props = {};
                    for (const key of Object.keys(r.propertyDeltas)) {
                        props[key] =
                            r.segment.properties[key] === undefined ? null : r.segment.properties[key];
                    }
                    if (lastAnnotate && lastAnnotate.pos2 === r.position &&
                        MergeTree.matchProperties(lastAnnotate.props, props)) {
                        lastAnnotate.pos2 += r.segment.cachedLength;
                    } else {
                        ops.push(MergeTree.createAnnotateRangeOp(
                            r.position,
                            r.position + r.segment.cachedLength,
                            props,
                            undefined));
                    }
                    break;

                case MergeTree.MergeTreeDeltaType.INSERT:
                    ops.push(MergeTree.createInsertOp(
                        r.position,
                        cloneDeep(r.segment.toJSONObject())));
                    break;

                case MergeTree.MergeTreeDeltaType.REMOVE:
                    const lastRem = ops[ops.length - 1] as MergeTree.IMergeTreeRemoveMsg;
                    if (lastRem && lastRem.pos1 === r.position) {
                        lastRem.pos2 += r.segment.cachedLength;
                    } else {
                        ops.push(MergeTree.createRemoveRangeOp(
                            r.position,
                            r.position + r.segment.cachedLength));
                    }
                    break;

                default:
            }
        }
        return ops;
    }

    protected client: MergeTree.Client;
    protected isLoaded = false;
    // Deferred that triggers once the object is loaded
    protected loadedDeferred = new Deferred<void>();
    private messagesSinceMSNChange: ISequencedDocumentMessage[] = [];
    private readonly intervalMapKernel: MapKernel;
    constructor(
        document: IComponentRuntime,
        public id: string,
        attributes: IChannelAttributes,
        public readonly segmentFromSpec: (spec: MergeTree.IJSONSegment) => MergeTree.ISegment,
    ) {
        super(id, document, attributes);

        /* tslint:disable:no-unsafe-any */
        this.client = new MergeTree.Client(
            segmentFromSpec,
            ChildLogger.create(this.logger, "SharedSegmentSequence.MergeTreeClient"),
            document.options);

        super.on("newListener", (event) => {
            switch (event) {
                case "sequenceDelta":
                    if (!this.client.mergeTreeDeltaCallback) {
                        this.client.mergeTreeDeltaCallback = (opArgs, deltaArgs) => {
                            this.emit("sequenceDelta", new SequenceDeltaEvent(opArgs, deltaArgs, this.client), this);
                        };
                    }
                    break;
                case "maintenance":
                    if (!this.client.mergeTreeMaintenanceCallback) {
                        this.client.mergeTreeMaintenanceCallback = (args) => {
                            this.emit("maintenance", new SequenceMaintenanceEvent(args, this.client), this);
                        };
                    }
                    break;
                default:
            }
        });
        super.on("removeListener", (event: string | symbol) => {
            switch (event) {
                case "sequenceDelta":
                    if (super.listenerCount(event) === 0) {
                        this.client.mergeTreeDeltaCallback = undefined;
                    }
                    break;
                case "maintenance":
                    if (super.listenerCount(event) === 0) {
                        this.client.mergeTreeMaintenanceCallback = undefined;
                    }
                    break;
                default:
            }
        });

        this.intervalMapKernel = new MapKernel(
            this.runtime,
            this.handle,
            (op) => this.submitLocalMessage(op),
            [new SequenceIntervalCollectionValueType()]);
    }

    /**
     * Registers a listener on the specified events
     */
    public on(event: "sequenceDelta", listener: (event: SequenceDeltaEvent, target: this) => void): this;
    public on(
        event: "pre-op" | "op",
        listener: (op: ISequencedDocumentMessage, local: boolean, target: this) => void): this;
    public on(event: string | symbol, listener: (...args: any[]) => void): this;
    // tslint:disable-next-line:no-unnecessary-override
    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    /**
     * @param start - The inclusive start of the range to remove
     * @param end - The exclusive end of the range to remove
     */
    public removeRange(start: number, end: number) {
        const removeOp = this.client.removeRangeLocal(start, end);
        if (removeOp) {
            this.submitSequenceMessage(removeOp);
        }
        return removeOp;
    }

    /**
     * Removes the range and puts the content of the removed range in a register
     *
     * @param start - The inclusive start of the range to remove
     * @param end - The exclusive end of the range to remove
     * @param register - The name of the register to store the removed range in
     */
    public cut(start: number, end: number, register: string) {
        const removeOp = this.client.removeRangeLocal(start, end, register);
        if (removeOp) {
            this.submitSequenceMessage(removeOp);
        }
    }

    /**
     * Inserts the content of the register.
     *
     * @param pos - The postition to insert the content at.
     * @param register - The name of the register to get the content from
     */
    public paste(pos: number, register: string) {
        const insertOp = this.client.pasteLocal(pos, register);
        if (insertOp) {
            this.submitSequenceMessage(insertOp);
        }
        return pos;
    }

    /**
     * Puts the content of the range in a register
     *
     * @param start - The inclusive start of the range
     * @param end - The exclusive end of the range
     * @param register - The name of the register to store the range in
     */
    public copy(start: number, end: number, register: string) {

        const insertOp = this.client.copyLocal(start, end, register);
        if (insertOp) {
            this.submitSequenceMessage(insertOp);
        }
    }

    public groupOperation(groupOp: MergeTree.IMergeTreeGroupMsg) {
        this.client.localTransaction(groupOp);
        this.submitSequenceMessage(groupOp);

    }

    public getContainingSegment(pos: number) {
        return this.client.getContainingSegment<T>(pos);
    }

    /**
     * Returns the length of the current sequence for the client
     */
    public getLength() {
        return this.client.getLength();
    }

    public getPosition(segment): number {
        return this.client.getPosition(segment);
    }

    /**
     * Annotates the range with the provided properties
     *
     * @param start - The inclusive start postition of the range to annotate
     * @param end - The exclusive end position of the range to annotate
     * @param props - The properties to annotate the range with
     * @param combiningOp - Optional. Specifies how to combine values for the property, such as "incr" for increment.
     *
     */
    public annotateRange(
        start: number,
        end: number,
        props: MergeTree.PropertySet,
        combiningOp?: MergeTree.ICombiningOp) {

        const annotateOp =
            this.client.annotateRangeLocal(start, end, props, combiningOp);
        if (annotateOp) {
            this.submitSequenceMessage(annotateOp);
        }
    }

    public getPropertiesAtPosition(pos: number) {
        return this.client.getPropertiesAtPosition(pos);
    }

    public getRangeExtentsOfPosition(pos: number) {
        return this.client.getRangeExtentsOfPosition(pos);
    }

    public createPositionReference(
        segment: T,
        offset: number,
        refType: MergeTree.ReferenceType): MergeTree.LocalReference {
        const lref = new MergeTree.LocalReference(this.client, segment, offset, refType);
        if (refType !== MergeTree.ReferenceType.Transient) {
            this.addLocalReference(lref);
        }
        return lref;
    }

    public localRefToPos(localRef: MergeTree.LocalReference) {
        if (localRef.segment) {
            return localRef.offset + this.getPosition(localRef.segment);
        } else {
            return -1;
        }
    }

    /**
     * Resolves a remote client's position against the local sequence
     * and returns the remote client's position relative to the local
     * sequence
     * @param remoteClientPosition - The remote client's position to resolve
     * @param remoteClientRefSeq - The reference sequence number of the remote client
     * @param remoteClientId - The client id of the remote client
     */
    public resolveRemoteClientPosition(
        remoteClientPosition: number,
        remoteClientRefSeq: number,
        remoteClientId: string): number {
        return this.client.resolveRemoteClientPosition(
            remoteClientPosition,
            remoteClientRefSeq,
            remoteClientId);

    }

    public submitSequenceMessage(message: MergeTree.IMergeTreeOp) {
        const translated = makeHandlesSerializable(
            message,
            this.runtime.IComponentSerializer,
            this.runtime.IComponentHandleContext,
            this.handle);
        this.submitLocalMessage(translated);
    }

    public addLocalReference(lref) {
        return this.client.addLocalReference(lref);
    }

    public removeLocalReference(lref) {
        return this.client.removeLocalReference(lref);
    }

    /**
     * Given a position specified relative to a marker id, lookup the marker
     * and convert the position to a character position.
     * @param relativePos - Id of marker (may be indirect) and whether position is before or after marker.
     */
    public posFromRelativePos(relativePos) {
        return this.client.posFromRelativePos(relativePos);
    }

    /**
     * Walk the underlying segments of the sequence.
     * The walked segments may extend beyond the range
     * if the segments cross the ranges start or end boundaries.
     * Set split range to true to esure only segments within the
     * range are walked.
     *
     * @param handler - The function to handle each segment
     * @param start - Optional. The start of range walk.
     * @param end - Optional. The end of range walk
     * @param accum - Optional. An object that will be passed to the handler for accumulation
     * @param splitRange - Optional. Splits boundary segements on the range boundaries
     */
    public walkSegments<TClientData>(
        handler: MergeTree.ISegmentAction<TClientData>,
        start?: number, end?: number, accum?: TClientData,
        splitRange: boolean = false) {

        return this.client.walkSegments<TClientData>(handler, start, end, accum, splitRange);
    }

    public getStackContext(startPos: number, rangeLabels: string[]) {
        return this.client.getStackContext(startPos, rangeLabels);
    }

    public getCurrentSeq() {
        return this.client.getCurrentSeq();
    }

    public insertAtReferencePosition(pos: MergeTree.ReferencePosition, segment: T) {
        const insertOp = this.client.insertAtReferencePositionLocal(pos, segment);
        if (insertOp) {
            this.submitSequenceMessage(insertOp);
        }
    }

    public async waitIntervalCollection(
        label: string,
    ): Promise<IntervalCollection<SequenceInterval>> {
        return this.intervalMapKernel.wait<IntervalCollection<SequenceInterval>>(
            this.getIntervalCollectionPath(label));
    }

    // TODO: fix race condition on creation by putting type on every operation
    public getIntervalCollection(label: string): IntervalCollection<SequenceInterval> {
        const labelPath = this.getIntervalCollectionPath(label);
        if (!this.intervalMapKernel.has(labelPath)) {
            this.intervalMapKernel.createValueType(
                labelPath,
                SequenceIntervalCollectionValueType.Name,
                undefined);
        }

        const sharedCollection =
            this.intervalMapKernel.get<IntervalCollection<SequenceInterval>>(labelPath);
        return sharedCollection;
    }

    public snapshot(): ITree {
        const tree: ITree = {
            entries: [
                {
                    mode: FileMode.File,
                    path: snapshotFileName,
                    type: TreeEntry[TreeEntry.Blob],
                    value: {
                        contents: this.intervalMapKernel.serialize(),
                        encoding: "utf-8",
                    },
                },
                {
                    mode: FileMode.Directory,
                    path: contentPath,
                    type: TreeEntry[TreeEntry.Tree],
                    value: this.snapshotMergeTree(),
                },

            ],
            id: null,
        };

        return tree;
    }

    protected replaceRange(start: number, end: number, segment: MergeTree.ISegment) {
        // insert first, so local references can slide to the inserted seg
        // if any
        const insert = this.client.insertSegmentLocal(end, segment);
        if (insert) {
            const remove = this.client.removeRangeLocal(start, end);
            this.submitSequenceMessage(MergeTree.createGroupOp(insert, remove));
        }
    }

    protected onConnect(pending: any[]) {

        for (const message of pending) {
            this.intervalMapKernel.trySubmitMessage(message);
        }

        // Update merge tree collaboration information with new client ID and then resend pending ops
        if (this.client.getCollabWindow().collaborating) {
            this.client.updateCollaboration(this.runtime.clientId);
        }

        const groupOp = this.client.resetPendingSegmentsToOp();
        if (groupOp) {
            this.submitSequenceMessage(groupOp);
        }
    }

    protected onDisconnect() {
        debug(`${this.id} is now disconnected`);
    }

    protected async loadCore(
        branchId: string,
        storage: IObjectStorageService) {

        const header = await storage.read(snapshotFileName);

        const data: string = header ? fromBase64ToUtf8(header) : undefined;
        this.intervalMapKernel.populate(data);

        const loader = this.client.createSnapshotLoader(this.runtime);
        try {
            const msgs = await loader.initialize(
                branchId,
                new ContentObjectStorage(storage));
            msgs.forEach((m) => this.processMergeTreeMsg(m));
            this.loadFinished();
        } catch (error) {
            this.loadFinished(error);
        }
    }

    protected processCore(message: ISequencedDocumentMessage, local: boolean) {
        let handled = false;
        if (message.type === MessageType.Operation) {
            handled = this.intervalMapKernel.tryProcessMessage(message, local);
        }

        if (!handled) {
            this.processMergeTreeMsg(message);
        }
    }

    protected registerCore() {
        for (const value of this.intervalMapKernel.values()) {
            if (SharedObject.is(value)) {
                value.register();
            }
        }

        this.client.startCollaboration(this.runtime.clientId, 0);
    }

    protected initializeLocalCore() {
        super.initializeLocalCore();
        assert(MergeTree.Snapshot.EmptyChunk.chunkSequenceNumber === 0);
        this.loadFinished();
    }

    private snapshotMergeTree(): ITree {
        // Are we fully loaded? If not, things will go south
        assert(this.isLoaded);

        const minSeq = this.runtime.deltaManager ? this.runtime.deltaManager.minimumSequenceNumber : 0;

        // Catch up to latest MSN, if we have not had a chance to do it.
        // Required for case where ComponentRuntime.attachChannel() generates snapshot right after loading component.
        // Note that we mock runtime in tests and mock does not have deltamanager implementation.
        if (this.runtime.deltaManager) {
            this.processMinSequenceNumberChanged(minSeq);
            this.client.updateSeqNumbers(minSeq, this.runtime.deltaManager.referenceSequenceNumber);

            // One of the snapshots (from SPO) I observed to have chunk.chunkSequenceNumber > minSeq!
            // Not sure why - need to catch it sooner
            assert(this.client.getCollabWindow().minSeq === minSeq);
        }

        const snap = this.client.createSnapshotter();
        snap.extractSync();
        this.messagesSinceMSNChange.forEach((m) => m.minimumSequenceNumber = minSeq);
        const mtSnap = snap.emit(
            this.messagesSinceMSNChange,
            this.runtime.IComponentSerializer,
            this.runtime.IComponentHandleContext,
            this.handle);

        return mtSnap;
    }

    private processMergeTreeMsg(rawMessage: ISequencedDocumentMessage) {
        const message = parseHandles(
            rawMessage,
            this.runtime.IComponentSerializer,
            this.runtime.IComponentHandleContext);

        const ops: MergeTree.IMergeTreeOp[] = [];
        function transfromOps(event: SequenceDeltaEvent) {
            ops.push(... SharedSegmentSequence.createOpsFromDelta(event));
        }
        const needsTransformation = message.referenceSequenceNumber !== message.sequenceNumber - 1;
        let stashMessage = message;
        if (needsTransformation) {
            stashMessage = cloneDeep(message);
            stashMessage.referenceSequenceNumber = message.sequenceNumber - 1;
            this.on("sequenceDelta", transfromOps);
        }

        this.client.applyMsg(message);

        if (needsTransformation) {
            this.removeListener("sequenceDelta", transfromOps);
            stashMessage.contents = ops.length !== 1 ? MergeTree.createGroupOp(...ops) : ops[0];
        }

        this.messagesSinceMSNChange.push(stashMessage);

        // Do GC every once in a while...
        if (this.messagesSinceMSNChange.length > 20
            && this.messagesSinceMSNChange[20].sequenceNumber < message.minimumSequenceNumber) {
            this.processMinSequenceNumberChanged(message.minimumSequenceNumber);
        }

    }

    private getIntervalCollectionPath(label: string) {
        return `intervalCollections/${label}`;
    }

    private processMinSequenceNumberChanged(minSeq: number) {
        let index = 0;
        for (; index < this.messagesSinceMSNChange.length; index++) {
            if (this.messagesSinceMSNChange[index].sequenceNumber > minSeq) {
                break;
            }
        }
        if (index !== 0) {
            this.messagesSinceMSNChange = this.messagesSinceMSNChange.slice(index);
        }
    }

    private loadFinished(error?: any) {
        // initialize the interval collections
        this.initializeIntervalCollections();
        if (error) {
            this.logger.sendErrorEvent({eventName: "SequenceLoadFailed" }, error);
            this.loadedDeferred.reject(error);
        } else {
            this.isLoaded = true;
            this.loadedDeferred.resolve();
        }
    }

    private initializeIntervalCollections() {

        // Listen and initialize new SharedIntervalCollections
        this.intervalMapKernel.eventEmitter.on("valueChanged", (ev: IValueChanged) => {
            const intervalCollection = this.intervalMapKernel.get<IntervalCollection<SequenceInterval>>(ev.key);
            if (!intervalCollection.attached) {
                intervalCollection.attach(this.client, ev.key);
            }
        });

        // Initialize existing SharedIntervalCollections
        for (const key of this.intervalMapKernel.keys()) {
            const intervalCollection = this.intervalMapKernel.get<IntervalCollection<SequenceInterval>>(key);
            intervalCollection.attach(this.client, key);
        }
    }
}
