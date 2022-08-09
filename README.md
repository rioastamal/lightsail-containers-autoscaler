## About

[Amazon Lightsail Containers](https://lightsail.aws.amazon.com/ls/docs/en_us/articles/amazon-lightsail-container-services) is one of the easiest way to run container based app on AWS. It automatically sets up a load balanced TLS endpoint, custom DNS, free private image registry and more. But I think  it lacks one important feature which is auto scaling. That's why I build this tool.

lightsail-containers-autoscaler support both dynamic scaling and scheduled scaling. The aim of this tool is to be as simple as possible hence it is only consist of single Javascript file `src/index.js`. You just need to schedule this tool run in regular interval and it will fetch metrics from the Lightsail Container and do the auto-scaling.

I recommend running this tool using Amazon EventBridge and AWS Lambda so you do not have to maintain any servers.

> WARNING: This project is in early development and not many tests has been conducted, use it at your own risk.

## Requirements

This tool has been tested using following:

- Node.js v16.x
- Serverless Framework 3.21 (Used to deploy to AWS)

## How to Install

Clone this repo or download the archive and extract to some directory.

```sh
git clone git@github.com:rioastamal/lightsail-containers-autoscaler.git
```

Install all required dependencies.

```sh
cd lightsail-containers-autoscaler
```

```sh
npm install
```

If you want to deploy to your AWS account, then you need to install Serverless Framework.

```
npm install -g serverless
```

## How to Deploy

Several resources will be created during deployment such as:

- Amazon DynamoDB
- Amazon EventBridge
- AWS Lambda

This deployment uses Serverless Framework so make sure to edit `serverless.yml` to suit your needs. Settings that you will likely to edit are `functions` section.

```yaml
functions:
  autoscaling:
    handler: src/index.handler
    events:
      - schedule:
          rate: rate(10 minutes)
          enabled: true
          input: 
            name: lightsail-containers-autoscaler
            rules:
            - enabled: true
              dry_run: false
              scaling_type: dynamic
              nodes: 3
              power: nano
              metric: cpu
              average: 20
              average_operator: gte
              average_duration_minutes: 10
              wait_after_last_deployment_minutes: 10
            - enabled: true
              dry_run: false
              scaling_type: dynamic
              nodes: 1
              power: nano
              metric: cpu
              average: 5
              average_operator: lte
              average_duration_minutes: 15
              wait_after_last_deployment_minutes: 30
            - enabled: true
              dry_run: false
              scaling_type: scheduled
              nodes: 2
              power: micro
              run_at: "* * 21 * * *"
              wait_after_last_deployment_minutes: 30
```

Change `schedule.rate` to run the function as your required interval. See [AWS Schedule Syntax](http://docs.aws.amazon.com/AmazonCloudWatch/latest/events/ScheduledEvents.html) for more details. The next thing you may want to change is `input`. It takes the same format as `input.sample.json` but in YAML format.

Make sure you already configure your AWS credentials via `~/.aws` or via `AWS_*` environment variables. To deploy just run:

```sh
export AWS_DEFAULT_REGION=ap-southeast-1
export APP_CONTAINER_SVC_NAME=demo-auto
```

```sh
serverless deploy
```

It will run the Lambda function every 10 minutes and do the auto scaling based on rules matched.

## How to Run (local)

To run locally, configure your AWS credentials via `~/.aws` or via `AWS_*` environment variables. Then make sure you have permissions to write to DynamoDB table and Lightsail Container service. Take a look at IAM permissions defined in serverless.yml file.

First, define required environment variables. In this case I am using `ap-southeast-1` and `demo-auto` as example values.

```sh
export NODE_ENV=development
export APP_REGION=ap-southeast-1
export APP_TABLE_NAME=ls-containers-autoscaling-$NODE_ENV
export APP_CONTAINER_SVC_NAME=demo-auto
```

You can use sample configuration `input.sample.json` as an input.

```sh
cat input.sample.json | node src/index.js
```

It will scale in/out the container service based on the rule matched.

If you want to simulate particular date then pass `APP_CURRENT_DATE` environment when running this tool.

```sh
cat input.sample.json | APP_CURRENT_DATE=2020-08-08T06:30:00+07:00 node src/index.js
```

## Configuration

Explanation of each attribute on configuration that used in as an input for the function.

Attribute | Required | Value | Description
----------|----------|-------|------------
name      | Required | `lightsail-containers-autoscaler` | Magic identifier
rules     | Required | Array | Lift of rules that need to be applied

Supported attributes for each element on `rules`.

Attribute | Required | Value | Description
----------|----------|-------|-------------
enabled   | Required | `true` or `false` | Enable or disable the rule
dry_run   | Required | `true` or `false` | Dry run mode, no update applied to the container service
scaling_type | Required | `dynamic` or `scheduled` | `dynamic` is based on metrics and `scheduled` is based on date/interval
nodes     | Required | Number | Number of nodes. [Max is 20](https://lightsail.aws.amazon.com/ls/docs/en_us/articles/amazon-lightsail-container-services#container-services-capacity)
power     | Required | String | Name of the [power](https://lightsail.aws.amazon.com/ls/docs/en_us/articles/amazon-lightsail-container-services#container-services-capacity) (CPU and RAM)
metric    | Required (dynamic) | `cpu` or `memory` | Metric to monitor, CPU or Memory
average   | Required (dynamic) | Number | Average percentage of the container service at given last `average_duration_minutes` minutes
average_operator | Required (dynamic) | `lte` or `gte` | Comparison operator. `lte` (less than equal) and `gte` (greater than equal)
average_duration_minutes | Required (dynamic) | Number | Duration of the metric to get. E.g: `10` means it will get average metric (cpu or memory) for the last 10 minutes
wait_after_last_deployment_minutes | Required | Number | Waiting time before doing another scaling. It will not do the scaling when last deployment under `wait_after_last_deployment_minutes`
run_at | Required (scheduled) | Cron Expression | Run scaling at specified interval using cron expression, e.g: `* * 19 * * *` means run auto scaling every 7pm. 

### Sample 1

1. Do scale out to 4 nodes and power to `micro` when average CPU metric is above 70 percent for the last 15 minutes. Only do scaling if last deployment is more than 10 minutes ago.
2. Do Scale in 1 node and power to `nano` when average CPU metric is below 5 percent for the last 45 minutes. Only do scaling if last deployment is more than 30 minutes ago.

```json
{
  "name": "lightsail-containers-autoscaler",
  "rules": [
    {
      "enabled": true,
      "dry_run": false,
      "scaling_type": "dynamic",
      "nodes": 4,
      "power": "micro",
      "metric": "cpu",
      "average": 70.0,
      "average_operator": "gte",
      "average_duration_minutes": 15,
      "wait_after_last_deployment_minutes": 10
    },
    {
      "enabled": true,
      "dry_run": false,
      "scaling_type": "dynamic",
      "nodes": 1,
      "power": "nano",
      "metric": "cpu",
      "average": 5.0,
      "average_operator": "lte",
      "average_duration_minutes": 15,
      "wait_after_last_deployment_minutes": 30
    }
  ]
}
```

### Sample 2

1. Do scale out to 6 nodes and power to `micro` every Monday to Friday at 8am to 4pm. Only do scaling if last deployment is more than 10 minutes ago.
2. Do scale in to 1 node and power to `nano` every Monday to Friday at 5pm to 7am. Only do scaling if last deployment is more than 30 minutes ago.
3. Do scale in to 1 node and power to `nano` every weekend. Only do scaling if last deployment is more than 30 minutes ago.

```json
{
  "name": "lightsail-containers-autoscaler",
  "rules": [
    {
      "enabled": true,
      "dry_run": false,
      "scaling_type": "scheduled",
      "nodes": 6,
      "power": "micro",
      "run_at": "* 0-59 8-16 * * 1-5",
      "wait_after_last_deployment_minutes": 10
    },
    {
      "enabled": true,
      "dry_run": false,
      "scaling_type": "scheduled",
      "nodes": 1,
      "power": "nano",
      "run_at": "0-59 0-7,17-23 * * 1-5",
      "wait_after_last_deployment_minutes": 30
    },
    {
      "enabled": true,
      "dry_run": false,
      "scaling_type": "scheduled",
      "nodes": 1,
      "power": "nano",
      "run_at": "* * * * 0,6",
      "wait_after_last_deployment_minutes": 30
    },
  ]
}
```

## To do

- Add unit tests
- Improve documentation

## Contributing

Fork this repo and send me a Pull Request (PR).

## License

This project is licensed under MIT License. See [LICENSE](LICENSE.md) file.