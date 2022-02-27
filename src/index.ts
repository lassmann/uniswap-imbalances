import Web3 from "web3";
import tokens from './tokens.json';
import paths from './uni_sushi_paths.json';
import fetch from 'node-fetch';
import objectsToCsv from 'objects-to-csv';
import { abi } from './abi';

(async () => {
    const client = new Web3("https://mainnet.infura.io/v3/22e3feb43fdc4fdabacb7c6144c883db");
    const sushiurl = 'https://api.thegraph.com/subgraphs/name/sushiswap/exchange';
    const uniurl = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2';
    const method = 'POST';
    const headers = { 'Content-Type': 'application/json' };
    try {
        const reservesContract = new client.eth.Contract(abi, '0x416355755f32b2710ce38725ed0fa102ce7d07e6');
        const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
        const tokenMap = {};
        // with this we filter paths to recover. If we only have one contract in the path we are sure there is not arbitrage
        const pathsToRecover = paths.filter(root => {
            const contracts = root.map(r => r[1]).flat();
            return Array.from(new Set(contracts)).length > 1;
        })

        const contractsToSearchMap = new Set();
        for (let i = 0; i < pathsToRecover.length; i++) {
            const root = pathsToRecover[i];
            for (let j = 0; j < root.length; j++) {
                const contracts = root[j][1];
                for (let k = 0; k < contracts.length; k++) {
                    contractsToSearchMap.add(contracts[k])
                }
            }
        }

        const pairContracts: any = Array.from(contractsToSearchMap);
        const uniQuery = { "query": `{  pairs(first:600, where:{id_in:${JSON.stringify(pairContracts)} }) {\n    id, token0 {\n      id\n    }\n, token1 {\n      id\n    }\n  }\n}` }

        let uniRes = await fetch(uniurl, {
            method,
            headers,
            body: JSON.stringify(uniQuery)
        })
        const uniResponse: any = await uniRes.json();

        let rates = uniResponse.data.pairs.reduce((all, actual) => ({ ...all, [actual.id]: { token0: actual.token0.id, token1: actual.token1.id } }), {});

        const sushiQuery = { "query": `{  pairs(first:600, where:{id_in:${JSON.stringify(pairContracts)} }) {\n    id, token0 {\n      id\n    }\n, token1 {\n      id\n    }\n  }\n}` }

        let sushires: any = await fetch(sushiurl, {
            method,
            headers,
            body: JSON.stringify(sushiQuery)
        });
        sushires = await sushires.json();
        rates = sushires.data.pairs.reduce((last, act) => ({ ...last, [act.id]: { token0: act.token0.id, token1: act.token1.id } }), rates);

        const reserves: any = await reservesContract.methods.viewPair(pairContracts).call(); // calling all the pairs

        for (let i = 0; i < pairContracts.length; i++) {
            const contractAddress = pairContracts[i]
            const pair = rates[contractAddress];
            const token0 = tokens.find(t => t.address === pair.token0);
            const token1 = tokens.find(t => t.address === pair.token1);
            tokenMap[token0.address] = token0;
            tokenMap[token1.address] = token1;
            const reservesToken0 = reserves[i * 2]
            const reservesToken1 = reserves[i * 2 + 1]
            rates[contractAddress].price = (reservesToken1 / Math.pow(10, Number(token1.decimals))) / (reservesToken0 / Math.pow(10, Number(token0.decimals)));
            rates[contractAddress].token0Symbol = token0.symbol;
            rates[contractAddress].token1Symbol = token1.symbol;
        }

        // function to choose wich is the best price when we have more than one contract for one pair
        const findBestPrice = (token0, pairList) => {
            let price = 0;
            for (let i = 0; i < pairList.length; i++) {
                const pair = pairList[i];
                let tempPrice;
                tempPrice = rates[pair].token0 === token0 ? rates[pair].price : 1 / rates[pair].price
                if (tempPrice > price) price = tempPrice
            }
            return price
        }

        const generatePath = (path) => {
            let str = "WETH =>"
            for (let i = 0; i < path.length - 1; i++) {
                const token = tokenMap[path[i][0]].symbol
                str = `${str} ${token} =>`
            }
            return `${str} WETH`;
        }

        let imbalances = []
        for (let i = 0; i < pathsToRecover.length; i++) {
            const root = pathsToRecover[i];
            let weth_tokens = 1 // amount of starting WETH
            for (let j = 0; j < root.length; j++) {
                const token0 = j === 0 ? WETH_ADDRESS : root[j - 1][0]
                const price = findBestPrice(token0, root[j][1]);
                weth_tokens = weth_tokens * price
            }
            if (weth_tokens > 1 && weth_tokens < 1.5) { // we ask for less than 1.5 because some pairs has no liquidity and the amount is insane and we know there is not arbitrage
                imbalances.push({ path: generatePath(root), imbalance: weth_tokens })
            }
        }
        const csv = new objectsToCsv(imbalances);
        await csv.toDisk('./imbalances.csv', null);
        console.table(await csv.toString());

    } catch (error) {
        console.error('error', error)
    }
})()
