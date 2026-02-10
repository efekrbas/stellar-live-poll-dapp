'use client';

import { useState, useEffect } from 'react';
import {
    isConnected,
    requestAccess,
    signTransaction,
    setAllowed
} from '@stellar/freighter-api';
import {
    Contract,
    Networks,
    TransactionBuilder,
    rpc,
    scValToNative,
    xdr,
    StrKey,
    Account,
    Keypair,
    nativeToScVal,
    Address,
    Horizon,
} from '@stellar/stellar-sdk';

const CONTRACT_ID = 'CD3FMPVW6CAOJTT7EQTC6U46FXMH5QIWLNA7MA4USTBIB7HM2PNMOWTG';
const RPC_URL = 'https://soroban-testnet.stellar.org';

export default function LivePoll() {
    const [walletConnected, setWalletConnected] = useState(false);
    const [userAddress, setUserAddress] = useState<string | null>(null);
    const [poll, setPoll] = useState<any>(null);
    const [txStatus, setTxStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
    const [txHash, setTxHash] = useState<string | null>(null);

    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        checkConnection();
        fetchPoll();
        // Real-time update simulation (polling every 5s)
        const interval = setInterval(fetchPoll, 5000);
        return () => clearInterval(interval);
    }, []);

    const checkConnection = async () => {
        try {
            const connected = await isConnected();
            if (connected) {
                const { address } = await requestAccess(); // Using requestAccess to get address if allowed
                if (address) {
                    setAllowed();
                    setWalletConnected(true);
                    setUserAddress(address);
                }
            }
        } catch (e) {
            console.error("Connection check failed", e);
        }
    };

    const connectWallet = async () => {
        try {
            const { address } = await requestAccess();
            if (address) {
                setAllowed();
                setWalletConnected(true);
                setUserAddress(address);
            }
        } catch (e) {
            alert("Please install Freighter wallet!");
        }
    };

    const fetchPoll = async () => {
        try {
            const server = new rpc.Server(RPC_URL);
            const contract = new Contract(CONTRACT_ID!);

            // Call get_poll
            const operation = contract.call('get_poll');
            const dummyAccount = new Account(Keypair.random().publicKey(), '0');
            const tx = new TransactionBuilder(
                dummyAccount,
                { fee: '100', networkPassphrase: Networks.TESTNET }
            ).addOperation(operation).setTimeout(30).build();

            const result = await server.simulateTransaction(tx);

            if (rpc.Api.isSimulationSuccess(result)) {
                const scval = result.result.retval;
                const pollData = scValToNative(scval);
                console.log("Poll Data Received:", pollData);
                setPoll(pollData);
                setError(null);
            } else {
                setError("Poll data could not be fetched. Has the poll been initialized?");
                console.warn("Simulation failed:", result);
            }
        } catch (e) {
            console.error("Error fetching poll:", e);
            setError("Error connecting to network.");
        }
    };

    const handleVote = async (optionIndex: number) => {
        if (!userAddress) return;
        setTxStatus('pending');
        setTxHash(null);

        try {
            const server = new rpc.Server(RPC_URL);
            const horizonServer = new Horizon.Server("https://horizon-testnet.stellar.org");
            const account = await horizonServer.loadAccount(userAddress);

            const contract = new Contract(CONTRACT_ID!);
            // Convert arguments to ScVal
            const args = [
                new Address(userAddress).toScVal(),
                nativeToScVal(optionIndex, { type: 'u32' })
            ];
            const op = contract.call('vote', ...args);

            const tx = new TransactionBuilder(account, {
                fee: '100', // Basic fee, will be bumped by prepareTransaction
                networkPassphrase: "Test SDF Network ; September 2015",
            })
                .addOperation(op)
                .setTimeout(30)
                .build();

            // IMPORTANT: Simulate and Prepare the transaction (Calculate resources)
            const preparedTx = await server.prepareTransaction(tx);

            const signedTx = await signTransaction(preparedTx.toXDR(), {
                network: "TESTNET",
                networkPassphrase: "Test SDF Network ; September 2015"
            });

            if (signedTx) {
                console.log("Signed Tx from Freighter:", signedTx);
                // Handle potential object response or string
                let xdrString = signedTx;
                if (typeof signedTx === 'object' && 'signedTxXdr' in signedTx) {
                    xdrString = (signedTx as any).signedTxXdr;
                }

                const signedTransaction = TransactionBuilder.fromXDR(xdrString, "Test SDF Network ; September 2015");
                const sentTx = await server.sendTransaction(signedTransaction);

                if (sentTx.status !== 'PENDING') {
                    setTxStatus('error');
                    console.error("Tx failed immediately:", JSON.stringify(sentTx, null, 2));
                    return;
                }

                // Poll for status
                let statusResult = null;
                const pollInterval = 1000;
                const maxRetries = 10;
                let retries = 0;

                while (retries < maxRetries) {
                    await new Promise(r => setTimeout(r, pollInterval));
                    statusResult = await server.getTransaction(sentTx.hash);
                    if (statusResult.status === 'SUCCESS') {
                        setTxStatus('success');
                        setTxHash(sentTx.hash);
                        fetchPoll(); // Update poll immediately
                        return;
                    } else if (statusResult.status === 'FAILED') {
                        setTxStatus('error');
                        return;
                    }
                    retries++;
                }
                // If we got here, we tailored out or it's still pending
                setTxHash(sentTx.hash); // Show hash anyway
            }

        } catch (e: any) {
            const errStr = e.toString() + (e.message || '');
            if (errStr.includes('Error(Contract, #3)') || errStr.includes('HostError')) {
                // Determine if it's the specific "Already Voted" error (#3)
                // We don't console.error here to keep console clean for expected logic
                console.warn("User tried to vote again (Contract Error #3)");
                setTxStatus('error');
                setError("You have already voted! (Contract Error #3)");
            } else if (errStr.includes('Error(Contract, #2)')) {
                setTxStatus('error');
                setError("Poll has ended! (Contract Error #2)");
            } else {
                // Log actual unexpected errors
                console.error(e);
                setTxStatus('error');
                setError("Transaction failed. Check console for details.");
            }
        }
    };

    return (
        <div className="p-6 max-w-2xl mx-auto bg-slate-800 text-white rounded-xl shadow-lg">
            <h1 className="text-3xl font-bold mb-6">Stellar Live Poll</h1>

            {/* Wallet Connection */}
            <div className="mb-6">
                {!walletConnected ? (
                    <button
                        onClick={connectWallet}
                        className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg transition"
                    >
                        Connect Freighter
                    </button>
                ) : (
                    <div className="flex items-center gap-2">
                        <span className="text-green-400">● Connected:</span>
                        <span className="text-xs font-mono bg-slate-900 p-1 rounded">
                            {userAddress?.slice(0, 5)}...{userAddress?.slice(-5)}
                        </span>
                    </div>
                )}
            </div>

            {/* Error Message */}
            {error && (
                <div className="p-4 mb-4 bg-red-900/50 border border-red-500 rounded text-red-200">
                    {error}
                </div>
            )}

            {/* Poll Display */}
            {poll ? (
                <div className="space-y-4">
                    <h2 className="text-2xl font-semibold text-purple-300">{poll.question?.toString()}</h2>
                    <div className="grid gap-3">
                        {poll.options?.map((opt: any, idx: number) => {
                            // Find vote count for this index
                            let votes = 0;
                            if (Array.isArray(poll.votes)) {
                                const found = poll.votes.find((v: any) => v[0] === idx);
                                if (found) votes = found[1];
                            } else if (poll.votes && typeof poll.votes === 'object') {
                                // Handle if votes is a plain object { "0": 1, "1": 5 }
                                // Keys effectively are the indices
                                if (idx in poll.votes) {
                                    votes = poll.votes[idx];
                                }
                            }

                            return (
                                <button
                                    key={idx}
                                    onClick={() => handleVote(idx)}
                                    disabled={txStatus === 'pending' || !walletConnected}
                                    className="flex justify-between items-center bg-slate-700 hover:bg-slate-600 p-4 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition"
                                >
                                    <span className="font-medium">{opt.toString()}</span>
                                    <span className="bg-slate-900 px-3 py-1 rounded-full text-sm">
                                        {votes} votes
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : (
                !error && <p className="text-gray-400 animate-pulse">Loading poll data...</p>
            )}

            {/* Transaction Status */}
            {txStatus !== 'idle' && (
                <div className={`mt-6 p-4 rounded-lg border ${txStatus === 'pending' ? 'border-yellow-500 bg-yellow-900/20 text-yellow-200' :
                    txStatus === 'success' ? 'border-green-500 bg-green-900/20 text-green-200' :
                        'border-red-500 bg-red-900/20 text-red-200'
                    }`}>
                    <div className="font-bold uppercase tracking-wider text-sm mb-1">
                        Status: {txStatus}
                    </div>
                    {txHash && (
                        <div className="text-xs break-all">
                            Hash: {txHash}
                            <a
                                href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="block mt-2 underline text-blue-400 hover:text-blue-300"
                            >
                                View on Stellar Explorer
                            </a>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
