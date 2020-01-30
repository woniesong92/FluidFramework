/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { BatchManager } from "@microsoft/fluid-core-utils";
import { IDocumentDeltaConnection } from "@microsoft/fluid-driver-definitions";
import {
    ConnectionMode,
    IClientJoin,
    IConnect,
    IConnected,
    IDocumentMessage,
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    IServiceConfiguration,
    ISignalMessage,
    ITokenClaims,
    MessageType,
    ScopeType,
} from "@microsoft/fluid-protocol-definitions";
import * as assert from "assert";

interface IAugmentedDocumentMessage {
    clientId: string;
    message: IDocumentMessage;
}

/**
 * Server implementation used by Creation driver.
 */
export class CreationServerMessagesHandler {

    public static getInstance(documentId?: string): CreationServerMessagesHandler {
        if (CreationServerMessagesHandler.instance === undefined && documentId !== undefined) {
            CreationServerMessagesHandler.instance = new CreationServerMessagesHandler(documentId);
        }
        return CreationServerMessagesHandler.instance;
    }

    private static instance: CreationServerMessagesHandler;

    // These are the queues for messages, signals, contents that will be pushed to server when
    // an actual connection is created.
    public readonly queuedMessages: ISequencedDocumentMessage[] = [];

    private sequenceNumber: number = 1;
    private minSequenceNumber: number = 0;
    private totalClients: number = 0;

    private readonly opSubmitManager: BatchManager<IAugmentedDocumentMessage[]>;

    private readonly connections: IDocumentDeltaConnection[] = [];

    private constructor(private readonly documentId: string) {
        // We supply maxBatchSize as infinity here because we do not want all messages to be processed synchronously.
        this.opSubmitManager = new BatchManager<IAugmentedDocumentMessage[]>(
            (submitType, work) => {
                for (const singleWork of work) {
                    for (const message of singleWork) {
                        const stampedMessage = this.stampMessage(message.message, message.clientId);
                        this.queuedMessages.push(stampedMessage);
                        for (const connection of this.connections) {
                            connection.emit("op", this.documentId, stampedMessage);
                        }
                    }
                }
            }, Number.MAX_VALUE);
    }

    /**
     * Messages to be processed by the server.
     * @param messages - List of messages to be stamped.
     * @param clientId - client id of the client sending the messages.
     */
    public submitMessage(messages: IDocumentMessage[], clientId: string) {
        for (const message of messages) {
            const augMessage: IAugmentedDocumentMessage = {
                clientId,
                message,
            };
            this.opSubmitManager.add("submitOp", [augMessage]);
        }
    }

    /**
     * Signals to be processed by the server.
     * @param signal - Signal to be broadcasted.
     */
    public submitSignal(signal: IDocumentMessage, clientId: string) {
        const signalMessage: ISignalMessage = {
            clientId,
            content: signal,
        };
        for (const connection of this.connections) {
            connection.emit("signal", signalMessage);
        }
    }

    /**
     * Initialize the details for the connction and send the join op.
     * @param connectMessage - Connection details received from the client.
     */
    public createClient(connectMessage: IConnect, connection: IDocumentDeltaConnection): IConnected {
        assert.equal(this.documentId, connectMessage.id, "docId for all messages should be same");
        const claims: ITokenClaims = {
            documentId: connectMessage.id,
            scopes: connectMessage.client.scopes,
            tenantId: connectMessage.tenantId,
            user: { id: connectMessage.client.user.id },
        };
        const DefaultServiceConfiguration: IServiceConfiguration = {
            blockSize: 65536,
            maxMessageSize: 16 * 1024,
            summary: {
                idleTime: 5000,
                maxOps: 1000,
                maxTime: 5000 * 12,
                maxAckWaitTime: 600000,
            },
        };
        const clientId: string = this.createClientId();
        const clientDetail: IClientJoin = {
            clientId,
            detail: connectMessage.client,
        };
        const joinMessage = this.createClientJoinMessage(clientDetail);
        this.queuedMessages.push(joinMessage);
        const existing = this.totalClients === 0 ? false : true;
        const details: IConnected = {
            claims,
            clientId,
            existing,
            maxMessageSize: 1024, // Readonly client can't send ops.
            mode: "read",
            parentBranch: null,
            serviceConfiguration: DefaultServiceConfiguration,
            initialClients: [{ clientId, client: connectMessage.client }],
            initialMessages: [joinMessage],
            supportedVersions: connectMessage.versions,
            version: connectMessage.versions[connectMessage.versions.length - 1],
        };
        if (this.isWriter(connectMessage.client.scopes, existing, connectMessage.mode)) {
            details.maxMessageSize = 16 * 1024;
            details.mode = "write";
        }
        this.totalClients += 1;
        assert.ok(this.totalClients <= 2, "Clients should never be more than 2");
        this.connections.push(connection);
        return details;
    }

    private createClientId() {
        return `newFileCreationClient${this.totalClients}`;
    }

    private isWriter(scopes: string[], existing: boolean, mode: ConnectionMode): boolean {
        if (this.canWrite(scopes) || this.canSummarize(scopes)) {
            // New document needs a writer to boot.
            if (!existing) {
                return true;
            } else {
                // Back-compat for old client and new server.
                if (mode === undefined) {
                    return true;
                } else {
                    return mode === "write";
                }
            }
        } else {
            return false;
        }
    }

    private canWrite(scopes: string[]): boolean {
        return scopes.length === 0 || scopes.includes(ScopeType.DocWrite) ? true : false;
    }

    private canSummarize(scopes: string[]): boolean {
        return scopes.length === 0 || scopes.includes(ScopeType.SummaryWrite) ? true : false;
    }

    /**
     * Stamps the messages like a server.
     * @param message - Message to be stamped.
     */
    private stampMessage(message: IDocumentMessage, clientId: string): ISequencedDocumentMessage {
        const stampedMessage: ISequencedDocumentMessage = {
            clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: message.contents,
            minimumSequenceNumber: message.referenceSequenceNumber!,
            referenceSequenceNumber: message.referenceSequenceNumber!,
            sequenceNumber: this.sequenceNumber++,
            timestamp: Date.now(),
            traces: message.traces !== undefined ? message.traces : [],
            type: message.type,
            metadata: message.metadata,
        };
        this.minSequenceNumber = stampedMessage.minimumSequenceNumber;
        assert.ok(stampedMessage.referenceSequenceNumber < this.sequenceNumber,
            "Reference seq number should be less than the current seq number");
        return stampedMessage;
    }

    /**
     * Creates the client join message.
     * @param clientDetail - Client details
     */
    private createClientJoinMessage(clientDetail: IClientJoin): ISequencedDocumentMessage {
        const joinMessage: ISequencedDocumentSystemMessage = {
            clientId: clientDetail.clientId,
            clientSequenceNumber: 0,
            contents: null,
            minimumSequenceNumber: this.minSequenceNumber,
            referenceSequenceNumber: -1,
            sequenceNumber: this.sequenceNumber++,
            timestamp: Date.now(),
            traces: [],
            data: JSON.stringify(clientDetail),
            type: MessageType.ClientJoin,
        };
        return joinMessage;
    }
}
