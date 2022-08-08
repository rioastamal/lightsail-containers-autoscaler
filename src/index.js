const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { 
  LightsailClient, 
  GetContainerServicesCommand,
  GetContainerServiceMetricDataCommand, 
  UpdateContainerServiceCommand } = require('@aws-sdk/client-lightsail');
const noLambda = process.env.hasOwnProperty('APP_NO_LAMBDA') === true;

const requiredEnvs = [
  'APP_CONTAINER_SVC_NAME', 
  'APP_TABLE_NAME'
];
let lastScalingResult = {};

for (const _env of requiredEnvs) {
  if (process.env.hasOwnProperty(_env) === false) {
    console.error(`ERROR: Missing ${_env} env.`);
    process.exit(1);
  }
}

const lightsailClient = new LightsailClient({ region: process.env.AWS_DEFAULT_REGION });
const ddbClient = new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION });

async function getContainersMetric(params) {
  const now = params.current_date || new Date();
  const startTime = new Date(now);
  startTime.setMinutes(now.getMinutes() - params.minutes);
  
  const serviceMetricParams = {
    serviceName: params.service_name,
    statistics: ["Average"],
    period: params.minutes * 60,
    metricName: params.metric === 'cpu' ? 'CPUUtilization' : 'MemoryUtilization',
    startTime: startTime,
    endTime: now
  };
  console.log('[fn getContainersMteric] serviceMetricParams', serviceMetricParams)
  const command = new GetContainerServiceMetricDataCommand(serviceMetricParams);
  
  const response = await lightsailClient.send(command);
  
  return response;
}

async function getCurrentContainer(params) {
  const command = new GetContainerServicesCommand({
    serviceName: params.service_name
  });
  
  const response = await lightsailClient.send(command);
  
  return response;
}

function getScalingInOrOut(params) {
  if (params.current_scale === params.target_scale) {
    return 'no_scaling';
  }
  
  if (params.current_scale > params.target_scale) {
    return 'scale_in';
  }
  
  return 'scale_out';
}

async function saveScalingResult(params) {
  const dbParams = {
    TableName: params.table_name,
    Item: marshall({
      pk: `lightsail-containers#auto-scaling#${params.service_name}`,
      sk: 'lightsail-containers',
      created_at: params.scaling_date || new Date().toISOString(),
      scaling_process: params.scaling_process,
      data: params.data
    })
  };
  
  console.log('[fn saveScalingResult] dbParams', dbParams);
  const response = await ddbClient.send(new PutItemCommand(dbParams));
  return response;
}

async function setLatestScalingResult(params) {
  const dbParams = {
    TableName: params.table_name,
    Key: marshall({
      pk: `lightsail-containers#auto-scaling#${params.service_name}`,
      sk: 'lightsail-containers'
    })
  };
  
  const response = await ddbClient.send(new GetItemCommand(dbParams));
  
  if (response.Item === undefined) {
    lastScalingResult = {
      service_name: params.service_name,
      power: null,
      scale: null,
      scaling_date: null,
      previous: {}
    };
    
    return;
  }
  
  const item = unmarshall(response.Item);
  lastScalingResult = {
    service_name: params.service_name,
    power: item.data.power,
    scale: item.data.scale,
    scaling_date: item.created_at,
    previous: item.data.previous
  };
}

async function scaleInOut(params) {
  if (params.rules.enabled !== true) {
    console.log('[fn scaleInOut] Scaling out is disabled.');
    return null;
  }
  
  if (['dynamic', 'scheduled'].indexOf(params.rules.scaling_type) === -1) {
    console.log('[fn scaleInOut] "scaling_type" rule value only accept "dynamic" or "scheduled".');
    return;
  }
  
  if (params.rules.scaling_type === 'dynamic') {
    if (['lte', 'gte'].indexOf(params.rules.average_operator) === -1) {
      console.log('[fn scaleInOut] "average_operator" rule value only accept "lte" or "gte".');
      return;
    }
  }

  const scalingProcess = getScalingInOrOut({
    current_scale: params.current.scale,
    target_scale: params.rules.nodes
  });
  
  if (scalingProcess === 'no_scaling') {
    console.log(`[fn scaleInOut] No change for number of nodes (current: ${params.current.scale})`);
    return null;
  }
  
  if (params.rules.scaling_type === 'dynamic') {
    console.log('[fn scaleInOut] Doing dynamic scaling...');
    const metricsForScalingParams = {
      metric: params.rules.metric,
      minutes: params.rules.average_duration_minutes,
      service_name: params.service_name,
      current_date: params.current.date || new Date()
    };
    console.log('[fn scaleInOut] metricsForScalingParams', metricsForScalingParams);
    const currentMetricResponse = await getContainersMetric(metricsForScalingParams);
    console.log('[fn scaleInOut] currentMetricResponse', currentMetricResponse);
    
    if (currentMetricResponse.hasOwnProperty('metricData') === false) {
      console.log('[fn scaleInOut] No metricData available.');
      return null;
    }
    
    const currentAverage = Math.floor(currentMetricResponse.metricData[0].average);
    const lastDeploymentDate = new Date(params.last_deployment);
    
    // Scale out comparison
    if (params.rules.average_operator === 'gte') {
      if (currentAverage < params.rules.average) {
        console.log(`[fn scaleInOut] Average metric still below threshold. Current: ${currentAverage} vs arg: ${params.rules.average}`);
        return null;
      }
    }
    
    // Scale in comparison
    if (params.rules.average_operator === 'lte') {
      if (currentAverage > params.rules.average) {
        console.log(`[fn scaleInOut] Average metric still above threshold. Current: ${currentAverage} vs arg: ${params.rules.average}`);
        return null;
      }
    }
  
    console.log('[fn scaleInOut] lastDeploymentDate: ', lastDeploymentDate);
    const lastDeploymentDateInMinutes = Math.floor( (Date.now() - lastDeploymentDate.getTime()) / 1000 / 60);
    console.log(`[fn scaleInOut] Comparing last date deployment minutes. Current: ${lastDeploymentDateInMinutes} vs arg: ${params.rules.wait_after_last_deployment_minutes}`);
    if (lastDeploymentDateInMinutes <= params.rules.wait_after_last_deployment_minutes) {
      console.log('[fn scaleInOut] Need to wait some more minutes. ' + (params.rules.wait_after_last_deployment_minutes - lastDeploymentDateInMinutes));
      return null;
    }
  }
    
  console.log(`[fn scaleInOut] Action -> ${scalingProcess} -> scale: ${params.rules.nodes}, power: ${params.rules.power}`);
  if (params.rules.dry_run === true) {
    console.log('[fn scaleInOut] Running in dry run, no real update performed.');
    return {
      "message": "Dry run, no scale out were performed."
    };
  }
  
  const scaleInOutResponse = await scaleContainer({
    service_name: params.service_name,
    power: params.rules.power,
    scale: params.rules.nodes,
    scaling_process: scalingProcess,
    current: {
      scale: params.current.scale,
      power: params.current.power
    }
  });
  
  console.log('[fn scaleInOut]', scaleInOutResponse);
  return scaleInOutResponse;
}

async function scaleContainer(params) {
  const command = new UpdateContainerServiceCommand({
    serviceName: params.service_name,
    power: params.power,
    scale: params.scale
  });
  
  const response = await lightsailClient.send(command);
  
  const nowString = new Date().toISOString();
  const scalingResultData = {
    service_name: params.service_name,
    power: params.power,
    scale: params.scale,
    scaling_date: nowString,
    previous: {
      power: params.current.power,
      scale: params.current.scale
    }
  };
  
  const scalingResultParams = {
    service_name: params.service_name,
    table_name: process.env.APP_TABLE_NAME,
    data: scalingResultData,
    scaling_process: params.scaling_process,
    scaling_date: nowString
  };
  
  saveScalingResult(scalingResultParams)
    .then(resp => {
      lastScalingResult = scalingResultData;
    })
    .catch(e => {
      console.log('[fn scaleContainer] Failed to save scaling result. Details: ' + e.toString());
    });
  
  return response;  
}

async function handler(event) {
  try {
    const obj = typeof event === 'string' ? JSON.parse(event) : event;
    
    if (obj.name !== 'lightsail-containers-autoscaler') {
      throw '[fn handler] Unknown event name: ' + obj.name;
    }
    
    const containerSvcName = process.env.APP_CONTAINER_SVC_NAME || null;
    
    const currentContainerResponse = await getCurrentContainer({ service_name: containerSvcName });
    const currentContainerService = currentContainerResponse['containerServices'][0];
    console.log('[fn handler] currentContainerService', currentContainerService);
    
    const currentDate = process.env.hasOwnProperty('APP_CURRENT_DATE') ? new Date(process.env.APP_CURRENT_DATE) : new Date();
    
    await setLatestScalingResult({
      service_name: containerSvcName,
      table_name: process.env.APP_TABLE_NAME
    });
    
    const scalingDate = lastScalingResult.scaling_date || currentContainerService.createdAt;
    for (const _rules of obj.rules) {
      const scaleOutParams = {
        rules: _rules,
        service_name: containerSvcName,
        last_deployment: scalingDate,
        current: {
          scale: currentContainerService.scale,
          power: currentContainerService.power,
          date: currentDate
        }
      };
      console.log('[fn handler] scaleOutParams', scaleOutParams);
      await scaleInOut(scaleOutParams);      
    }
  
    const response = {
      statusCode: 200,
      body: JSON.stringify(obj, null, 2)
    };
    
    return response;
  } catch (e) {
    let errCode = 400;
    
    if (e.hasOwnProperty('$metadata') === true) {
      errCode = e['$metadata'].httpStatusCode;
    }
    
    return {
      statusCode: errCode,
      body: e.toString(),
      stack: e.stack
    };
  }
}

// Execute directly the file e.g: from CLI
if (noLambda) {
  const read = async(stream) => {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    return Buffer.concat(chunks).toString('utf8');
  };
  
  (async () => {
    const eventInput = await read(process.stdin);
    const output = await handler(eventInput);
    console.log(output);
  })();
  
  return;
}

exports.handler = handler;