'use client';

import { useState, useEffect, useRef } from 'react';
import {
    isConnected,
    requestAccess,
    signTransaction,
    setAllowed
} from '@stellar/freighter-api';
import { xBullWalletConnect } from '@creit.tech/xbull-wallet-connect';
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

type WalletType = 'freighter' | 'xbull' | null;

export default function LivePoll() {
    const [selectedWallet, setSelectedWallet] = useState<WalletType>(null);
    const [walletConnected, setWalletConnected] = useState(false);
    const [userAddress, setUserAddress] = useState<string | null>(null);
    const [poll, setPoll] = useState<any>(null);
    const [txStatus, setTxStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
    const [txHash, setTxHash] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const xBullRef = useRef<xBullWalletConnect | null>(null);

    useEffect(() => {
        fetchPoll();
        // Fallback polling for general updates (every 10s)
        const interval = setInterval(fetchPoll, 10000);

        // Real-time Event Listening (every 3s)
        const eventInterval = setInterval(fetchEvents, 3000);

        return () => {
            clearInterval(interval);
            clearInterval(eventInterval);
        };
    }, []);

    const fetchEvents = async () => {
        try {
            const server = new rpc.Server(RPC_URL);
            // Get events from a recent ledger
            const latestLedger = await server.getLatestLedger();
            const startLedger = latestLedger.sequence - 100;

            const response = await server.getEvents({
                startLedger,
                filters: [
                    {
                        type: 'contract',
                        contractIds: [CONTRACT_ID],
                        topics: [[xdr.ScVal.scvSymbol('poll').toXDR('base64'), '*']]
                    }
                ],
                limit: 10
            });

            if (response.events && response.events.length > 0) {
                console.log("New Soroban events detected:", response.events.length);
                fetchPoll(); // Refresh poll data based on event
            }
        } catch (e) {
            console.warn("Error fetching events:", e);
        }
    };

    const connectFreighter = async () => {
        try {
            const connected = await isConnected();
            if (!connected) {
                setError("Freighter wallet is not installed. Please install the Freighter browser extension.");
                return;
            }
            const { address } = await requestAccess();
            if (address) {
                setAllowed();
                setWalletConnected(true);
                setUserAddress(address);
                setSelectedWallet('freighter');
                setError(null);
            }
        } catch (e) {
            setError("Failed to connect Freighter wallet. Please make sure it is installed and unlocked.");
        }
    };

    const connectXBull = async () => {
        try {
            const bridge = new xBullWalletConnect();
            xBullRef.current = bridge;
            const publicKey = await bridge.connect();
            if (publicKey) {
                setWalletConnected(true);
                setUserAddress(publicKey);
                setSelectedWallet('xbull');
                setError(null);
            }
        } catch (e) {
            if (xBullRef.current) {
                xBullRef.current.closeConnections();
                xBullRef.current = null;
            }
            setError("Failed to connect xBull wallet. Please make sure it is installed and unlocked.");
        }
    };

    const disconnectWallet = () => {
        if (xBullRef.current) {
            xBullRef.current.closeConnections();
            xBullRef.current = null;
        }
        setWalletConnected(false);
        setUserAddress(null);
        setSelectedWallet(null);
        setTxStatus('idle');
        setTxHash(null);
        setError(null);
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

            if (rpc.Api.isSimulationSuccess(result) && result.result) {
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

            let account;
            try {
                account = await horizonServer.loadAccount(userAddress);
            } catch (loadErr: any) {
                // Account not found on testnet — try to fund via Friendbot
                if (loadErr?.response?.status === 404 || loadErr?.message?.includes('Not Found')) {
                    setError("Account not found on testnet. Funding via Friendbot...");
                    try {
                        await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(userAddress)}`);
                        // Wait a moment for the account to be created
                        await new Promise(r => setTimeout(r, 2000));
                        account = await horizonServer.loadAccount(userAddress);
                        setError(null);
                    } catch (fundErr) {
                        console.error("Friendbot funding failed:", fundErr);
                        setTxStatus('error');
                        setError("Your account does not exist on the Stellar testnet and automatic funding failed. Please fund your account manually at https://friendbot.stellar.org");
                        return;
                    }
                } else {
                    throw loadErr;
                }
            }

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

            // Sign with the appropriate wallet
            let xdrString: string = '';

            if (selectedWallet === 'freighter') {
                const signedTx = await signTransaction(preparedTx.toXDR(), {
                    networkPassphrase: "Test SDF Network ; September 2015"
                });

                if (signedTx) {
                    console.log("Signed Tx from Freighter:", signedTx);
                    xdrString = typeof signedTx === 'string' ? signedTx : '';
                    if (typeof signedTx === 'object' && 'signedTxXdr' in signedTx) {
                        xdrString = (signedTx as any).signedTxXdr;
                    }
                }
            } else if (selectedWallet === 'xbull' && xBullRef.current) {
                const signedXdr = await xBullRef.current.sign({
                    xdr: preparedTx.toXDR(),
                    network: "Test SDF Network ; September 2015"
                });
                xdrString = signedXdr;
            }

            if (!xdrString) {
                setTxStatus('error');
                setError("Transaction signing was cancelled or failed.");
                return;
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
            // If we got here, we timed out or it's still pending
            setTxHash(sentTx.hash); // Show hash anyway

        } catch (e: any) {
            const errStr = e.toString() + (e.message || '');
            if (errStr.includes('Error(Contract, #3)') || errStr.includes('HostError')) {
                console.warn("User tried to vote again (Contract Error #3)");
                setTxStatus('error');
                setError("You have already voted! (Contract Error #3)");
            } else if (errStr.includes('Error(Contract, #2)')) {
                setTxStatus('error');
                setError("Poll has ended! (Contract Error #2)");
            } else {
                console.error(e);
                setTxStatus('error');
                setError("Transaction failed. Check console for details.");
            }
        }
    };

    // ─── Wallet Selection Screen ───
    if (!walletConnected) {
        return (
            <div className="p-8 max-w-2xl mx-auto bg-slate-800 text-white rounded-2xl shadow-2xl">
                <h1 className="text-3xl font-bold mb-2 text-center">Stellar Live Poll</h1>
                <p className="text-slate-400 text-center mb-8">Connect your wallet to start voting</p>

                {error && (
                    <div className="p-4 mb-6 bg-red-900/50 border border-red-500 rounded-lg text-red-200 text-sm">
                        {error}
                    </div>
                )}

                <div className="space-y-4">
                    <h2 className="text-lg font-semibold text-purple-300 mb-3">Choose a Wallet</h2>

                    {/* Freighter Wallet Option */}
                    <button
                        onClick={connectFreighter}
                        className="w-full flex items-center gap-4 bg-slate-700 hover:bg-slate-600 p-5 rounded-xl transition-all duration-200 border border-slate-600 hover:border-purple-500 group"
                    >
                        <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center text-2xl shrink-0">
                            🚀
                        </div>
                        <div className="text-left">
                            <div className="font-bold text-lg group-hover:text-purple-300 transition-colors">Freighter</div>
                            <div className="text-slate-400 text-sm">Stellar&apos;s most popular browser wallet</div>
                        </div>
                        <div className="ml-auto text-slate-500 group-hover:text-purple-400 transition-colors">
                            →
                        </div>
                    </button>

                    {/* xBull Wallet Option */}
                    <button
                        onClick={connectXBull}
                        className="w-full flex items-center gap-4 bg-slate-700 hover:bg-slate-600 p-5 rounded-xl transition-all duration-200 border border-slate-600 hover:border-blue-500 group"
                    >
                        <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-2xl shrink-0">
                            🐂
                        </div>
                        <div className="text-left">
                            <div className="font-bold text-lg group-hover:text-blue-300 transition-colors">xBull</div>
                            <div className="text-slate-400 text-sm">Advanced Stellar wallet with DeFi features</div>
                        </div>
                        <div className="ml-auto text-slate-500 group-hover:text-blue-400 transition-colors">
                            →
                        </div>
                    </button>
                </div>

                <p className="text-slate-500 text-xs text-center mt-6">
                    Don&apos;t have a wallet? Install{' '}
                    <a href="https://www.freighter.app/" target="_blank" rel="noreferrer" className="text-purple-400 hover:text-purple-300 underline">Freighter</a>
                    {' '}or{' '}
                    <a href="https://xbull.app/" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline">xBull</a>
                    {' '}to get started.
                </p>
            </div>
        );
    }

    // ─── Connected / Poll View ───
    return (
        <div className="p-8 max-w-2xl mx-auto bg-slate-800 text-white rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-3xl font-bold">Stellar Live Poll</h1>
                <button
                    onClick={disconnectWallet}
                    className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg transition text-slate-300 hover:text-white"
                >
                    Disconnect
                </button>
            </div>

            {/* Wallet Info */}
            <div className="mb-6 flex items-center gap-2">
                <span className="text-green-400">● Connected</span>
                <span className="text-xs px-2 py-0.5 bg-slate-700 rounded-full text-slate-300 uppercase tracking-wider font-semibold">
                    {selectedWallet}
                </span>
                <span className="text-xs font-mono bg-slate-900 p-1 rounded">
                    {userAddress?.slice(0, 5)}...{userAddress?.slice(-5)}
                </span>
            </div>

            {/* Error Message */}
            {error && (
                <div className="p-4 mb-4 bg-red-900/50 border border-red-500 rounded-lg text-red-200">
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
                        Status: {txStatus === 'pending' ? '⏳ Pending...' : txStatus === 'success' ? '✅ Success' : '❌ Error'}
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
