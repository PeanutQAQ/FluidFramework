/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IConnectionDetails,
    IDeltaHandlerStrategy,
    IDeltaManager,
    IDeltaQueue,
    IDeltaSender,
} from "@microsoft/fluid-container-definitions";
import { EventForwarder } from "@microsoft/fluid-common-utils";
import {
    ConnectionMode,
    IClientDetails,
    IDocumentMessage,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalMessage,
    MessageType,
} from "@microsoft/fluid-protocol-definitions";

/**
 * Proxy to the real IDeltaQueue - used to restrict access
 */
export class DeltaQueueProxy<T> extends EventForwarder implements IDeltaQueue<T> {
    public get paused(): boolean {
        return this.queue.paused;
    }

    public get length(): number {
        return this.queue.length;
    }

    public get idle(): boolean {
        return this.queue.idle;
    }

    private systemPaused = false;
    private localPaused = false;

    constructor(private readonly queue: IDeltaQueue<T>) {
        super(queue);
    }

    public peek(): T | undefined {
        return this.queue.peek();
    }

    public toArray(): T[] {
        return this.queue.toArray();
    }

    public async systemPause(): Promise<void> {
        this.systemPaused = true;
        return this.queue.pause();
    }

    public async pause(): Promise<void> {
        this.localPaused = true;
        return this.queue.pause();
    }

    public async systemResume(): Promise<void> {
        this.systemPaused = false;
        return this.updateResume();
    }

    public async resume(): Promise<void> {
        this.localPaused = false;
        return this.updateResume();
    }

    private async updateResume(): Promise<void> {
        if (!this.systemPaused && !this.localPaused) {
            return this.queue.resume();
        }
    }
}

/**
 * Proxy to the real IDeltaManager - used to restrict access
 */
export class DeltaManagerProxy
    extends EventForwarder
    implements IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {

    public readonly inbound: IDeltaQueue<ISequencedDocumentMessage>;
    public readonly outbound: IDeltaQueue<IDocumentMessage[]>;
    public readonly inboundSignal: IDeltaQueue<ISignalMessage>;

    public get IDeltaSender(): IDeltaSender {
        return this;
    }

    public get minimumSequenceNumber(): number {
        return this.deltaManager.minimumSequenceNumber;
    }

    public get referenceSequenceNumber(): number {
        return this.deltaManager.referenceSequenceNumber;
    }

    public get initialSequenceNumber(): number {
        return this.deltaManager.initialSequenceNumber;
    }

    public get clientDetails(): IClientDetails {
        return this.deltaManager.clientDetails;
    }

    public get version(): string {
        return this.deltaManager.version;
    }

    public get maxMessageSize(): number {
        return this.deltaManager.maxMessageSize;
    }

    public get serviceConfiguration(): IServiceConfiguration {
        return this.deltaManager.serviceConfiguration;
    }

    public get active(): boolean {
        return this.deltaManager.active;
    }

    public get readonly(): boolean | undefined {
        return this.deltaManager.readonly;
    }

    constructor(private readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>) {
        super(deltaManager);

        this.inbound = new DeltaQueueProxy(deltaManager.inbound);
        this.outbound = new DeltaQueueProxy(deltaManager.outbound);
        this.inboundSignal = new DeltaQueueProxy(deltaManager.inboundSignal);
    }

    public dispose(): void {
        this.inbound.dispose();
        this.outbound.dispose();
        this.inboundSignal.dispose();
        super.dispose();
    }

    public close(): void {
        return this.deltaManager.close();
    }

    public async connect(requestedMode: ConnectionMode): Promise<IConnectionDetails> {
        return this.deltaManager.connect(requestedMode);
    }

    public async getDeltas(
        reason: string,
        from: number,
        to?: number,
    ): Promise<ISequencedDocumentMessage[]> {
        return this.deltaManager.getDeltas(reason, from, to);
    }

    public attachOpHandler(
        minSequenceNumber: number,
        sequenceNumber: number,
        handler: IDeltaHandlerStrategy,
        resume: boolean,
    ) {
        return this.deltaManager.attachOpHandler(minSequenceNumber, sequenceNumber, handler, resume);
    }

    public submitSignal(content: any): void {
        return this.deltaManager.submitSignal(content);
    }

    public submit(type: MessageType, contents: any, batch: boolean, appData: any): number {
        return this.deltaManager.submit(type, contents, batch, appData);
    }

    public flush(): void {
        return this.deltaManager.flush();
    }
}
